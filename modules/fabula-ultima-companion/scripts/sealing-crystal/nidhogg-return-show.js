// ============================================================================
// Nidhogg's return, as played in game (every client). The clock is
// nidhogg-return.js (the approved mockup v21's timeline); this file puts it on
// the canvas. The shell mirrors nidhogg-fall-show.js: a show per client on its
// own clock, a ticker, finish(), the GM's present (broadcast + a wall clock the
// rules follow), the Boss Cycle registration.
//
// WP1 (2026-11-15): a STUB show. It already does what the real one must:
//   - holds the CRYSTAL (crystal-runtime holdCrystal: the show's state wins over
//     out-of-play, so the core can go out of play at `hidden` while the show
//     still draws it) and the arena VOID (holdArenaVoid) until the reveal; from
//     the reveal the arena is held LIT on this client (holdArenaLit), so the
//     cycle's next phase reaching this client late cannot leave the black plate
//     up under the return's veil;
//   - hides the HUD for the whole show (out over its first 0.3 s, back over its
//     last 0.5 s, shared/hud-curtain.js);
//   - keeps HIS token hidden (mesh, bars, nameplate, effects, shadow) until the
//     end, then hands him back to Foundry;
//   - owns ONE show container just above the backdrop, under every battler (the
//     fall's layering rule: his mesh sorts in front of the party, so the real
//     show draws his sprite inside this container: veil -> back smoke -> his
//     sprite -> front smoke -> glow -> rings -> dim + eye fire; the shake moves
//     only this container).
// PHASE 1 (WP3, 2026-11-16): the dark closes in on the crystal (crystal-painter
// st.close: the Worker darkens what it painted, return-close.js), the core stays
// bright (flameK / flameSee up as the glass goes); then the soul's last light, a
// star drawn here in pixels (its own small layer at the crystal's heart, snapped
// to the crystal's pixel grid, just above the crystal), from the last 0.45 s of
// the core to black.
// PHASE 2 (WP4, 2026-11-16): the composition, in the show container, in the
// mockup's order: veil -> back smoke -> his sprite -> front smoke -> his glowing
// parts (halo, halo, pixels; eyes, mouth, claws) -> the roar's rings -> [WP5's
// look] -> the break's flash. Laid out by return-stage.js: the smoke's frame on
// the scene's battle framing, everything of his on his sprite where the game
// draws it (drawnRect: the 3D camera's spot), riding his idle sway. The smoke is
// the WP2 painter in the shared Worker (its own listener: it replies
// { layers: { back, front, veil }, rects }); the parts and halos come from his
// token's texture (blurred once, cropped to each part); the rings are painted
// here (a 600 x 500 frame round his mouth, at the smoke's rate). His sprite in
// the container is his token's own texture at his mesh's rect, so the hand-back
// at the end (container gone, mesh back, same tick) has nothing to pop. All of
// it is built at the black (nothing moves on screen then), and the first smoke
// frame (tau 0: the veil whole) is up before the roar, so the arena void is let
// go at the roar with the veil already over the arena. A black frame covers the
// window outside the smoke's buffers while the veil still reaches their edge
// (a client zoomed out past the mockup's margin).
// CAMERA, HUD, HIS LOOK (WP5, 2026-11-16): the camera is driven every frame from
// the black to the end of the pull-back through the 2D view (canvas.pan;
// return-look.js returnView = the mockup's flat camAt on the battle framing: push
// in on his head to 2.0x at 0.42 W, creep to 2.12x, pull back to 0.92x at the
// roar, rest by tau 1.5); the 3D camera follows the 2D view, is CLAIMED for the
// show and his drawn head is aimed through predictDrawn; the player's camera
// fence is suspended meanwhile; with Battle depth Off it is the same flat zoom.
// The HUD curtain is the show's own (maxS long on a stepped clock). His look: the
// eye and mouth part sprites burn up and throb (lookGlow), the eye's burst
// (eyeBurst, painted here at the smoke's rate into a small frame round his eye),
// the dark round the screen's edges (one gradient texture centred on his head,
// in the container: the party stays lit). His sprite stays in the container
// until his look is over (the dark lies over him, as in the mockup), then moves
// to his own depth; his shadow fades in over what is left (~0.45 s).
// Without his token or its pixels, a fallback: the flat dark plate thinning out
// from the roar to the clear while his mesh fades in.
// The phase-1 floor glow seen on the rig (WP3 review) was the turn glow's red
// floor pool of the ACTING enemy (the rig plays the return mid-turn); the crystal
// draws no floor light in the void (floorClip off). The show clears the turn
// glow as it starts all the same, so phase 1 always ends on black.
//
// The plan (len / pause / doneAt) is fixed by the GM and sent with the spec, so
// every client and the GM's rules share the same beats.
// ============================================================================

import { warn, log } from "../battle-director/logger.js";
import { shouldRender, hasOtherViewers } from "../battle-director/presentation-clock.js";
import { channel, channelMode, holdShadow, placeAfter, bufferSprite, takeFrame, laneCount } from "./crystal-host-lib.js";
import { takeBand, resetTake } from "./box-frame.js";
import { returnVeil } from "./return-smoke.js";
import { spritePixels, drawnRect } from "./nidhogg-fall-show.js";
import { returnStage, frameOn, viewOf, glowPart, paintRings, ringsBox, boxBlurRGBA, PART_KEYS, HALO, HPAD, PX, MG, RING_FRAME } from "./return-stage.js";
import { holdTurnGlowOff } from "../battle-director/turn-glow.js";
import { rigFor, whenRig, paintedTexture, keepRigLive } from "../creature-rig/rig-host.js";
import { stageOf } from "../battle-director/director-camera.js";
import { createFrame, clearFrame, painterFor } from "../battle-director/pixel-entrance/pixelfx/core/index.js";
import { getClientOption } from "../shared/client-options.js";
import { FRAME, premultiply } from "./crystal-painter.js";
import { SOUL_UP_FX, bedVolume } from "./nidhogg-fall.js";
import { closeLook, glintAt, star, STAR } from "./return-close.js";
import { hideHud, showHud, setHudLevel } from "../shared/hud-curtain.js";
import { holdArenaVoid, holdArenaLit } from "./arena-void.js";
import { holdCrystal, crystalPlace, crystalDeathsPlaying } from "./crystal-runtime.js";
import { returnPlan, returnState, returnBeats, lateStartAt, LATE_MIN, CAMF, CLOSE, returnSfx, returnBed } from "./nidhogg-return.js";
import { makeCueTrack, cueUrl, cueUrls } from "../shared/sfx-cues.js";
import { playSfx, playBed, preloadSfx } from "../battle-director/director-sfx.js";
import { returnView, lookGlow, dimPixels, DIM, eyeBurst, lookFrameAt, LOOK_FRAME, floorPoints, fitFloor, shiftOf, rectMap, frameMatrix, mapPoint, unmapPoint } from "./return-look.js";
import { restViewFor } from "../battle-director/director-camera.js";
import { suspendCamera } from "../battle-director/camera-authority.js";
import { registerBossCycleTransition } from "../battle-director/boss-rules/boss-cycle-styles.js";

const MODULE_ID = "fabula-ultima-companion";
const MSG = "FU_NIDHOGG_RETURN";
const NAME = "nidhogg-return";
const DRAWN_HOOK = "fu-stage3d-drawn";   // battle-stage-3d-camera.js: the 3D camera has laid out this frame
const PAD_SCREEN = 400;
const DIM_TEX = 512;      // the look's dark: its texture (px); the middle is his head, the edge 2 x DIM.r1 mockup px out   // the plate's margin round the visible window (screen px), room for the shake
const TOKEN_PARTS = ["bars", "nameplate", "effects", "tooltip", "border", "targetArrows", "targetPips"];

const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const u = clamp((v - a) / (b - a)); return u * u * (3 - 2 * u); };
/** The plan as sent (only what changes the beats). */
const planOf = (o) => returnPlan({ len: o?.len, pause: o?.pause, doneAt: o?.doneAt, burstN: o?.burstN });
const wirePlan = (P) => ({ len: P.len, pause: P.pause, doneAt: P.doneAt, burstN: P.burstN });

const _shows = new Set();
const stage3d = () => globalThis.FUCompanion?.api?.battleStage3d ?? null;
/** A point of his sprite (sprite px, unmirrored) on a rect where the sprite is drawn (scene px). */
const pointOn = (R, uv, mirrored, W, H) => ({ x: mirrored ? R.x + R.w - (uv.u * R.w) / W : R.x + (uv.u * R.w) / W, y: R.y + (uv.v * R.h) / H });
/** A container placed by an affine ({ a, b, c, d, tx, ty }, PIXI's): position, scale, skew from the matrix. */
let _m = null;
const setMatrix = (c, m) => { (_m ??= new PIXI.Matrix()).set(m.a, m.b, m.c, m.d, m.tx, m.ty); c.transform.setFromMatrix(_m); };
/** The crystal's pixel row that holds its heart (crystal-painter FRAME; seed 68: 424 - 117.2 = 306.8 -> row 306). */
const HEART_ROW = Math.floor(FRAME.FLOOR - SOUL_UP_FX);

/* -- The soul's last light: a small pixel frame, painted here (~28 k px, well under a millisecond) -- */

class StarLayer {
  constructor() {
    const { W, H } = STAR;
    this.frame = createFrame(W, H);
    this.c = new Uint32Array(W * H); this.l = new Uint32Array(W * H);
    this.root = new PIXI.Container();
    this.root.name = "fud-nidhogg-return:star"; this.root.eventMode = "none"; this.root.visible = false;
    this.color = bufferSprite(W, H); this.light = bufferSprite(W, H);
    this.light.sp.blendMode = PIXI.BLEND_MODES.ADD;
    this.root.addChild(this.color.sp, this.light.sp);
    canvas.primary.addChild(this.root);
    this.S = null; this.empty = true; this.frames = 0;
  }
  /** Paint the light at strength S (the middle pixel of the frame is the heart). */
  paint(S) {
    if (S === this.S) return;
    const { W, H } = STAR;
    this.S = S;
    clearFrame(this.frame);
    star(painterFor(this.frame), S, { x: W / 2, y: H / 2 });
    const cR = premultiply(this.frame.color, this.c, W, H), lR = premultiply(this.frame.light, this.l, W, H);
    takeFrame(this.color, this.c.buffer, cR, W); takeFrame(this.light, this.l.buffer, lR, W);
    this.empty = !cR && !lR; this.frames++;
  }
  drop() {
    if (this.dropped) return;
    this.dropped = true;
    try { this.root.parent?.removeChild(this.root); this.root.destroy({ children: true, texture: true, baseTexture: true }); } catch { /* gone */ }
  }
}

/* -- Phase 2: the smoke (the WP2 painter "return"; its own reply shape) -- */

let _uid = 0;
const SMOKE_LAYERS = ["veil", "back", "front"];
/** Rigs / A-B on a real GPU: `globalThis.__FU_RETURN_PRE_WP6__ = true` paints as before WP6 (one Worker for all three
 *  layers, the veil on the CPU, the rings' whole frame premultiplied and copied). Read as each return is built. */
const preWP6 = () => !!globalThis.__FU_RETURN_PRE_WP6__;

/*
 * The veil on the GPU (WP6): the black over the arena is a pure function of the pixel and tau (return-smoke.js
 * returnVeil: the on-screen distance from his mouth, the 4-step Bayer dither in effect px), so a shader draws it
 * instead of the Worker painting 0.5 M px a frame and this thread copying + uploading ~2 MB of it. Same pixels (bar
 * float32 rounding on a dither threshold: the perf rig counts them against the CPU veil). A quad of W x H effect px,
 * placed like the sprite it replaces (NEAREST: each fragment takes its effect pixel's value), premultiplied black.
 */
const VEIL_VERT = `
attribute vec2 aVertexPosition;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
varying vec2 vPx;
void main(void) {
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
  vPx = aVertexPosition;
}`;
const VEIL_FRAG = `
precision highp float;
varying vec2 vPx;
uniform vec4 uColor;
uniform vec2 uM;
uniform float uSq;
uniform float uK;
uniform float uRc;
uniform float uBand;
uniform float uFull;
uniform vec4 uClip;
// (return-smoke.js BAY: the 4 x 4 Bayer matrix, row y, (v + 0.5) / 16; M4 = 4 M2(p mod 2) + M2(p / 2 mod 2))
float bay(vec2 p) {
  vec2 a = mod(p, 2.0), b = mod(floor(p / 2.0), 2.0);
  float m2a = 2.0 * a.x + 3.0 * a.y - 4.0 * a.x * a.y, m2b = 2.0 * b.x + 3.0 * b.y - 4.0 * b.x * b.y;
  return (4.0 * m2a + m2b + 0.5) / 16.0;
}
void main(void) {
  vec2 p = floor(vPx);
  float al = 0.0;
  if (uFull > 0.5) al = 1.0;
  else if (p.x >= uClip.x && p.y >= uClip.y && p.x < uClip.z && p.y < uClip.w) {
    float d = length(vec2(p.x + 0.5 - uM.x, (p.y + 0.5 - uM.y) / uSq)) / uK;
    float m = clamp((d - uRc) / uBand, 0.0, 1.0);
    if (m > 0.0) {
      float q = m * 4.0, b = floor(q);
      float k = (b + (q - b > bay(p) ? 1.0 : 0.0)) / 4.0;
      al = floor(255.0 * k + 0.5) / 255.0;
    }
  }
  gl_FragColor = vec4(0.0, 0.0, 0.0, al) * uColor.a;
}`;
let _veilProgram = null, _veilOk = null;
/** Can this renderer draw the GPU veil? (compiled + linked once per page; a failure keeps the Worker's CPU veil) */
export function veilShaderOk() {
  if (preWP6()) return false;
  if (_veilOk !== null) return _veilOk;
  try {
    if (!PIXI.Mesh || !PIXI.MeshMaterial || !PIXI.Program || !PIXI.Geometry) return (_veilOk = false);
    const r = canvas?.app?.renderer;
    if (!r?.gl || r.gl.isContextLost?.()) return false;   // (asked again next time)
    _veilProgram ??= PIXI.Program.from(VEIL_VERT, VEIL_FRAG, "fu-nidhogg-return-veil");
    const sh = new PIXI.MeshMaterial(PIXI.Texture.WHITE, { program: _veilProgram, uniforms: veilUniforms(1, 1) });
    r.shader.bind(sh, false);
    const glp = _veilProgram.glPrograms?.[r.CONTEXT_UID]?.program;
    _veilOk = !!glp && !!r.gl.getProgramParameter(glp, r.gl.LINK_STATUS);
    sh.destroy();
  } catch (e) { warn("nidhogg-return: no GPU veil (the Worker paints it)", e); _veilOk = false; }
  return _veilOk;
}
const veilUniforms = (W, H, v = null) => ({ uM: new Float32Array([v?.mx ?? 0, v?.my ?? 0]), uSq: v?.sq ?? 1, uK: v?.k ?? 1, uRc: 0, uBand: v?.band ?? 1, uFull: 1, uClip: new Float32Array([0, 0, W, H]) });
export class VeilMesh {
  /** W x H effect px; veil: returnVeil(W, H, ...) (the field's numbers). */
  constructor(W, H, veil) {
    this.W = W; this.H = H; this.veil = veil;
    this.geometry = new PIXI.Geometry().addAttribute("aVertexPosition", [0, 0, W, 0, W, H, 0, H], 2).addIndex([0, 1, 2, 0, 2, 3]);
    this.uniforms = veilUniforms(W, H, veil);
    this.material = new PIXI.MeshMaterial(PIXI.Texture.WHITE, { program: _veilProgram, uniforms: this.uniforms });
    this.sp = new PIXI.Mesh(this.geometry, this.material);
    this.sp.eventMode = "none"; this.sp.name = "fud-nidhogg-return:veil";
    this.tau = null;
  }
  /** The veil at tau inside the view's clip (as the Worker's drawVeil). */
  set(tau, view) {
    const u = this.material.uniforms, c = this.veil.clip(view);
    u.uFull = tau <= 0 ? 1 : 0; u.uRc = tau <= 0 ? 0 : this.veil.rc(tau);
    u.uClip[0] = c[0]; u.uClip[1] = c[1]; u.uClip[2] = c[2]; u.uClip[3] = c[3];
    this.tau = tau;
  }
  destroy() {
    try { this.sp.parent?.removeChild(this.sp); this.sp.destroy(); } catch { /* gone */ }
    try { this.material.destroy(); } catch { /* gone */ }
    try { this.geometry.destroy(); } catch { /* gone */ }
  }
}

/**
 * The smoke: its painters and its three layers. WP6: back and front are painted AT ONCE in two Workers (lane 0, the
 * shared one, and lane 1, made for the return and terminated with it), the veil on the GPU (VeilMesh); a frame is
 * shown when every part of it is in, so the layers always share one tau. Without a second Worker (or a GPU veil) the
 * missing part is painted with the back on lane 0, as before WP6. The frames' buffers go back to the painters that
 * sent them (no allocation per frame).
 */
/**
 * The JIT warm-up (smoke perf pass, 2026-11-16): the roar's heaviest smoke frames, painted in the quiet seconds between
 * the black and the roar (tau -5.15 .. 0) by the very painters that will paint them and thrown away (painter draw with
 * warm: nothing handed back, nothing shown). The front's lane-1 Worker is new for every play, and its first frames cost
 * ~3x a warm one on the real GPU machine (95 vs 30 ms). One warm frame in flight at a time per part; none is sent
 * once the roar is closer than 0.6 s + 3x the last one's wall time, so the roar's frames never wait behind one.
 * (60 fps pass, 2026-11-17: 8 frames left the painters still cooling, 83 -> 22 ms by the 8th; the roar's first half
 * second ran at 2-3x the warm cost. 24 frames now, the first 8 as before; with 4 bands the quiet seconds hold them.)
 */
const WARM_TAUS = Object.freeze([0.25, 0.4, 0.55, 0.33, 0.48, 0.62, 0.2, 0.7, 0.1, 0.45, 0.3, 0.5, 0.05, 0.38, 0.6, 0.15, 0.8, 0.42, 0.28, 0.52, 0.35, 0.58, 0.12, 0.44]);
const noWarm = () => globalThis.__FU_RETURN_NO_WARM__ === true;
/*
 * The roar at 60 (2026-11-17, the 60 fps pass). The smoke was asked for 30 times a second (the plan's smokeHz) and
 * painted as two layers in two Workers (back / front, 29-40 ms a frame at the roar's peak). Now it is painted in
 * horizontal BANDS: n painters on lanes 0..n-1, each painting BOTH layers for its rows only (return-painter.js band;
 * smoke-cloud.js frameH: the whole frame's pixels for those rows), joined into the layers' sprites (takeBand); a frame
 * is shown when every band of it is in. PIXEL-IDENTICAL to one painter (Node, the real recorded return: 0 of 1800
 * frames differ, 2 / 3 / 4 bands). The smoke is asked for at the client's frame rate (60, or 30 with the 30 fps
 * option), on a running due time; a tick that finds a frame in flight asks for the next the moment it is in (as the
 * fall's Layer and the crystal's death). The rings and his eye's flame keep the plan's 30 (ringHz): only the smoke's
 * rate changed. A CPU veil (no GPU veil) keeps the WP6 plan (back + veil / front). A/B: `__FU_RETURN_LANES__` = 1..4
 * (1: one painter), `__FU_RETURN_BANDS__` = false (the WP6 back / front split), `__FU_RETURN_SMOKE_HZ__` = 30.
 * smoke-cloud.js's shade skips the slope's atan where it cannot change the colour (~18% of a painter's time, the same
 * pixels: the fall's and the return's replays, 0 differing).
 */
/** Where the smoke's buffers are cut into n bands (fractions of their height), from the real return's per-row cost
 * (Node, slowest painter p95, all at once: back / front 26.6 ms, 4 bands 11-12.3, 6 bands 8.8-10.4). Real GPU machine
 * (12 threads), the roar's first second: back / front at 30 Hz 26-30 fps; 4 bands 50-54; 6 bands 58-60. */
export const RETURN_CUTS = Object.freeze({ 1: Object.freeze([]), 2: Object.freeze([0.417]), 3: Object.freeze([0.25, 0.583]), 4: Object.freeze([0.167, 0.375, 0.667]),
  5: Object.freeze([0.125, 0.292, 0.5, 0.75]), 6: Object.freeze([0.125, 0.25, 0.417, 0.583, 0.792]) });
export function returnBands(H, n) {
  const cuts = RETURN_CUTS[Math.max(1, Math.min(6, n | 0))] ?? RETURN_CUTS[1], e = [0];
  for (const c of cuts) e.push(Math.min(H, Math.max(e.at(-1) + 1, Math.min(H - 1, Math.round(H * c)))));
  e.push(H);
  return e.slice(0, -1).map((y0, i) => [y0, e[i + 1]]).filter(([a, b]) => b > a);
}
/** Lanes for the roar's smoke: 6 on 12+ logical cores, 4 on 8+, else as laneCount (`__FU_RETURN_LANES__` = 1..6 overrides). */
export function returnLanes() {
  const o = Number(globalThis.__FU_RETURN_LANES__);
  if (o >= 1 && o <= 6) return Math.floor(o);
  const cores = Number(globalThis.navigator?.hardwareConcurrency) || 4;
  return cores >= 12 ? 6 : cores >= 8 ? 4 : laneCount();
}
const noBands = () => globalThis.__FU_RETURN_BANDS__ === false;

class SmokeLayer {
  /**
   * inputs: returnStage().smoke ({ W, H, cam, at, src, seed, body, under, genW }); tauNow: () => { tau, view, now }
   * (the show's smoke clock now and the view last asked for: a missed tick's frame is asked for as the last one lands).
   */
  constructor(inputs, { tauNow = null } = {}) {
    this.id = `r${++_uid}:smoke`; this.W = inputs.W; this.H = inputs.H; this.inputs = inputs; this.tauNow = tauNow;
    this.ready = false; this.inflight = false; this.seq = 0; this.shown = false; this.frames = 0; this.dropped = false;
    this.nextDue = -Infinity; this.missed = false; this.hz = 60; this.nLanes = returnLanes();
    this.tau = null; this.pendingTau = null; this.pendingView = null; this.rects = { veil: null, back: null, front: null }; this.ms = 0; this.worst = 0;
    this.edge = true;   // the veil reaches the buffers' edge (worked out with each frame)
    this.cost = [];     // rigs: per frame { tau, wall (asked -> every part in, ms), parts: [{ lane, layers, ms, msBy }] }
    this.warmed = { i: 0, busy: 0, seq: 0, wall: 0, at: 0, ms: [] };   // the JIT warm-up (WARM_TAUS)
    this.veil = returnVeil(this.W, this.H, inputs);
    this.gpuVeil = veilShaderOk();
    this.veilMesh = null;
    this.sp = {};
    if (this.gpuVeil) {
      try { this.veilMesh = new VeilMesh(this.W, this.H, this.veil); this.sp.veil = this.veilMesh; }
      catch (e) { warn("nidhogg-return: GPU veil failed (the Worker paints it)", e); this.gpuVeil = false; this.veilMesh = null; }
    }
    for (const k of SMOKE_LAYERS) if (!this.sp[k]) this.sp[k] = bufferSprite(this.W, this.H);
    for (const k of SMOKE_LAYERS) { const s = this.sp[k].sp; s.eventMode = "none"; s.position.set(-MG * PX, -MG * PX); s.scale.set(PX); }
    // two Workers when the shared one is a Worker (a page that fell back to the main thread paints everything once)
    this.#plan(channelMode(0) !== "local" && channelMode(0) !== "dead" && !preWP6());
  }
  /** The parts: [{ lane, layers, band }] (band null: the whole buffers). */
  #plan(twoLanes) {
    const cpu = this.gpuVeil ? [] : ["veil"], n = twoLanes ? this.nLanes : 1;
    const plan = n < 2 ? [{ lane: 0, layers: ["back", "front", ...cpu] }]
      // the WP6 split: a CPU veil goes with the back (a veil is never banded), or the A/B switch
      : cpu.length || noBands() ? [{ lane: 0, layers: ["back", ...cpu] }, { lane: 1, layers: ["front"] }]
      : returnBands(this.H, n).map((band, i) => ({ lane: i, layers: ["back", "front"], band }));
    if (this.shown) for (const k of ["back", "front"]) if (this.sp[k] && this.sp[k] !== this.veilMesh) resetTake(this.sp[k], this.W, this.H);
    this.parts = plan.map((p, i) => ({ ...p, band: p.band ?? null, id: `${this.id}:${i}${n > 1 ? "" : "s"}`, ch: channel(p.lane), ready: false, spare: {}, got: null }));
    for (const p of this.parts) this.#init(p);
  }
  #init(p) {
    const { cam, at, src, seed, body, under, genW } = this.inputs;
    p.ready = false;
    p.ch.init(p.id, { W: this.W, H: this.H }, undefined, (m) => this.#onMessage(p, m), { painter: "return", returnSmoke: { cam, at, src, seed, body, under, genW, layers: p.layers, ...(p.band ? { band: p.band } : {}) } });
  }
  #onMessage(p, m) {
    if (this.dropped || !this.parts.includes(p)) return;
    if (m.type === "ready") { p.ready = true; this.ready = this.parts.every((q) => q.ready); return; }
    if (m.type === "restart") {
      this.ready = false; this.inflight = false; this.warmed.busy = 0;
      // a lane's Worker failed: everything back on lane 0 (one painter), as before WP6
      if (p.lane > 0 || this.parts.length > 1) { const old = this.parts; this.parts = []; for (const q of old) { try { q.ch.drop(q.id); } catch { /* gone */ } } this.#plan(false); return; }
      this.#init(p); return;
    }
    if (m.type === "warm") {
      const w = this.warmed;
      if (m.seq === w.seq && w.busy > 0 && --w.busy === 0) { w.wall = performance.now() - w.at; w.ms.push(+(m.ms ?? 0).toFixed(1)); }
      return;
    }
    if (m.type === "error") { this.inflight = false; this.errors = (this.errors ?? 0) + 1; for (const q of this.parts) q.got = null; return; }
    if (m.type !== "frame" || m.seq !== this.seq) return;
    p.got = m;
    if (!this.parts.every((q) => q.got)) return;
    // every part is in: one frame, all layers at one tau
    this.inflight = false;
    const got = this.parts.map((q) => q.got);
    try {
      this.parts.forEach((q, i) => {
        const g = got[i];
        for (const k of Object.keys(g.layers)) {
          if (q.band) takeBand(this.sp[k], g.layers[k], g.rects[k], this.W, q.band);
          else takeFrame(this.sp[k], g.layers[k], g.rects[k], this.W);
        }
      });
      this.veilMesh?.set(this.pendingTau, this.pendingView);
    } catch (e) { warn("nidhogg-return: smoke upload failed", e); }
    for (const q of this.parts) { q.spare = q.got.layers; q.got = null; }
    // each layer's box: the union of its bands' (whole-buffer rows)
    const rects = { veil: null, back: null, front: null };
    for (const g of got) for (const [k, r] of Object.entries(g.rects ?? {})) { const a = rects[k]; rects[k] = !r ? a : !a ? r : [Math.min(a[0], r[0]), Math.min(a[1], r[1]), Math.max(a[2], r[2]), Math.max(a[3], r[3])]; }
    this.rects = rects;
    this.edge = this.veilMesh ? this.veil.edge(this.pendingTau, this.pendingView) : this.#rectEdge(this.rects.veil);
    this.tau = this.pendingTau;
    this.ms = Math.max(...got.map((g) => g.ms ?? 0)); this.worst = Math.max(this.worst, this.ms);
    this.cost.push({ tau: this.tau, wall: +(performance.now() - this.askedAt).toFixed(2), parts: this.parts.map((q, i) => ({ lane: q.lane, layers: q.layers, ms: +(got[i].ms ?? 0).toFixed(2), msBy: got[i].msBy ?? null })) });
    if (this.cost.length > 300) this.cost.shift();
    this.shown = true; this.frames++;
    // a tick went by while it was painted: the next frame now, not at the next tick (as nidhogg-fall-show.js Layer)
    if (this.missed && this.tauNow && !this.dropped) {
      this.missed = false;
      try { const { tau, view, now } = this.tauNow(); if (tau > 0) this.want(tau, view, now, this.hz, true); } catch { /* the next tick asks */ }
    }
  }
  /**
   * The roar's frames (tau > 0): one asked every 1 / hz s on a running due time with a few ms of slack, one in flight;
   * a tick that finds one in flight is noted as missed, and the next is asked as soon as it is in (late). True when asked.
   */
  want(tau, view, now, hz, late = false) {
    if (!this.ready || this.dropped || this.warmed.busy) return false;
    this.hz = hz;
    const period = 1000 / hz, slack = Math.min(4, period / 4);
    if (!late && now + slack < this.nextDue) return false;
    if (this.inflight) { this.missed = true; return false; }
    if (!this.request(tau, view)) return false;
    this.nextDue = Math.max(this.nextDue + period, now + period - slack);
    return true;
  }
  #rectEdge(r) { return !!r && (r[0] <= 0 || r[1] <= 0 || r[2] >= this.W - 1 || r[3] >= this.H - 1); }
  /** Ask for the frame at tau (one in flight); view: the on-screen part of the buffers. True when asked. */
  request(tau, view) {
    if (!this.ready || this.inflight || this.dropped || this.warmed.busy) return false;
    this.inflight = true; this.pendingTau = tau; this.pendingView = view; this.askedAt = performance.now();
    const seq = ++this.seq;
    for (const p of this.parts) {
      const spare = p.spare; p.spare = {}; p.got = null;
      p.ch.draw(p.id, seq, tau, { T: tau, view }, null, null, spare);
    }
    return true;
  }
  /** The JIT warm-up (WARM_TAUS): tau now (< 0), the view to paint for. True when one was sent. */
  warm(tau, view) {
    const w = this.warmed;
    if (noWarm() || !this.ready || this.inflight || this.dropped || w.busy || w.i >= WARM_TAUS.length || !(tau < 0)) return false;
    if (-tau < 0.6 + (3 * w.wall) / 1000) { w.i = WARM_TAUS.length; return false; }
    const parts = this.parts.filter((p) => p.ch.mode === "worker");
    if (!parts.length) { w.i = WARM_TAUS.length; return false; }
    const T = WARM_TAUS[w.i++];
    w.busy = parts.length; w.seq++; w.at = performance.now();
    for (const p of parts) p.ch.warm(p.id, w.seq, { job: "draw", T, st: { T, view }, reserve: w.i === 1 ? this.W * this.H : 0 });
    return true;
  }
  /** The veil still reaches the buffers' edge (the window outside them must stay black). */
  veilAtEdge() { return this.edge; }
  /**
   * (WP7) The GPU veil follows the view EVERY frame, not only when a smoke frame lands: it is a shader, so its clip
   * costs nothing, and the edge test goes with it (~3 k pixel tests). Seen on the 3D-camera stills: a frame asked while
   * the camera was still moving (the 3D camera eases on its own clock) kept its clip, so the strips the view grew into
   * after it were neither veil nor outer plate and the arena showed through. The CPU veil (painted pixels) cannot.
   */
  follow(view) {
    if (!this.veilMesh || !this.shown || this.dropped || this.tau == null || !view) return;
    this.veilMesh.set(this.tau, view);
    this.edge = this.veil.edge(this.tau, view);
  }
  /** Rigs: how the frames are painted. */
  lanes() { return { gpuVeil: !!this.veilMesh, hz: this.hz, parts: this.parts.map((p) => ({ lane: p.lane, layers: p.layers, band: p.band, mode: p.ch.mode })), warm: { frames: this.warmed.ms.length, ms: this.warmed.ms } }; }
  drop() {
    if (this.dropped) return;
    this.dropped = true;
    for (const p of this.parts ?? []) { try { p.ch.drop(p.id); } catch { /* gone */ } p.spare = {}; p.got = null; }
    for (const k of SMOKE_LAYERS) {
      const o = this.sp[k];
      if (o === this.veilMesh) { o?.destroy(); continue; }
      try { o.sp.parent?.removeChild(o.sp); o.sp.destroy({ texture: true, baseTexture: true }); } catch { /* gone */ }
    }
  }
}

/* -- Phase 2: his glowing parts, from his token's pixels (halos blurred ONCE, cropped to each part) -- */

/** A canvas holding straight RGBA. */
function canvasOf(w, h, data = null) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  if (data) c.getContext("2d").putImageData(new ImageData(data, w, h), 0, 0);
  return c;
}
/** A part's halo: its pixels blurred on a canvas padded HPAD round them (the canvas' blur, else return-stage's). */
function haloCanvas(src, blur) {
  const c = canvasOf(src.width + 2 * HPAD, src.height + 2 * HPAD), g = c.getContext("2d", { willReadFrequently: true });
  let filtered = false;
  try { g.filter = `blur(${blur}px)`; filtered = g.filter === `blur(${blur}px)`; } catch { /* none */ }
  g.drawImage(src, HPAD, HPAD);
  g.filter = "none";
  // a canvas that keeps the filter string but ignores it leaves the padding empty: blur by hand then
  const d = g.getImageData(0, 0, c.width, c.height);
  let edge = 0;
  for (let x = 0; x < c.width; x++) edge += d.data[((HPAD >> 1) * c.width + x) * 4 + 3] + d.data[((c.height - 1 - (HPAD >> 1)) * c.width + x) * 4 + 3];
  for (let y = 0; y < c.height; y++) edge += d.data[(y * c.width + (HPAD >> 1)) * 4 + 3] + d.data[(y * c.width + c.width - 1 - (HPAD >> 1)) * 4 + 3];
  if (!filtered || edge === 0) {
    g.clearRect(0, 0, c.width, c.height); g.drawImage(src, HPAD, HPAD);
    const raw = g.getImageData(0, 0, c.width, c.height);
    boxBlurRGBA(raw.data, c.width, c.height, blur);
    g.putImageData(raw, 0, 0);
  }
  return c;
}
/*
 * Phase 2's still pieces, made AHEAD (2026-11-17, the 60 fps pass). Built at the black (#prep) they took ~180 ms in
 * one frame on the real GPU machine: his parts' halos (~140 ms: the canvas blur, the hand blur where the canvas'
 * one leaves the padding empty, the readbacks), the veil shader's first compile (~20 ms) and the look's dark (~12 ms).
 * None of them depends on where he stands or on the moment: only on his painting (or on nothing). So the return
 * transition's prepare (prepareNidhoggReturn, while his battle is on this canvas) makes them in idle moments, one
 * piece a task, and #prep takes them from here: the SAME canvases (and his pixels), so the same pixels on screen. A
 * piece not made yet is made at the black, as before, and kept for the next return. The textures stay the show's own
 * (one per show, destroyed with it: a canvas outlives its texture). `__FU_RETURN_NO_STILL__` = true: none (A/B).
 */
const _still = new WeakMap();   // his painting's source (image / canvas) -> Map(frame key -> { img, parts: Map(k -> { g, pc, halos[] } | null) })
let _dimCanvas = null;
const noStill = () => globalThis.__FU_RETURN_NO_STILL__ === true;
/** The still pieces of a texture (made with his pixels when `make`), or null (none, or a texture that cannot key them). */
function stillOf(tex, make = false) {
  const src = tex?.baseTexture?.resource?.source, fr = tex?.frame;
  if (noStill() || !src || typeof src !== "object" || !fr) return null;
  const key = `${fr.x},${fr.y},${fr.width},${fr.height}`;
  let m = _still.get(src), e = m?.get(key) ?? null;
  if (!e && make) {
    const img = spritePixels(tex);
    if (!img) return null;
    e = { img, parts: new Map() };
    if (!m) _still.set(src, (m = new Map()));
    m.set(key, e);
  }
  return e;
}
/** Part k of still pieces e: { g, pc, halos } made up to `halos` halos (HALO order); null when he has no glow there. */
function stillPart(e, k, halos = HALO.length) {
  let q = e.parts.get(k);
  if (q === undefined) {
    const g = glowPart(e.img, k);
    q = g ? { g, pc: canvasOf(g.w, g.h, g.data), halos: [] } : null;
    e.parts.set(k, q);
  }
  if (q) while (q.halos.length < halos) q.halos.push(haloCanvas(q.pc, HALO[q.halos.length].blur));
  return q;
}
/** The look's dark (one per page: it depends on nothing). */
const dimCanvas = () => (noStill() ? canvasOf(DIM_TEX, DIM_TEX, dimPixels(DIM_TEX)) : (_dimCanvas ??= canvasOf(DIM_TEX, DIM_TEX, dimPixels(DIM_TEX))));
/** The pieces as tasks (each small enough for an idle moment: one part's pixels, or one halo). */
function stillTasks(token) {
  const tasks = [() => veilShaderOk(), () => dimCanvas()];
  let e = null;
  tasks.push(() => { const t = token(); e = t && !t.destroyed && t.mesh ? stillOf(paintedTexture(t), true) : null; });
  for (const k of PART_KEYS) {
    tasks.push(() => { if (e) stillPart(e, k, 0); });
    for (let i = 1; i <= HALO.length; i++) tasks.push(() => { if (e) stillPart(e, k, i); });
  }
  return tasks;
}
/** Rigs: the still pieces made so far for a token ({ img, parts: { k: halos made | null } }, or null). */
function stillStatus(t) {
  const e = t ? stillOf(paintedTexture(t)) : null;
  return e ? { img: !!e.img, parts: Object.fromEntries([...e.parts].map(([k, q]) => [k, q ? q.halos.length : null])), dim: !!_dimCanvas, veil: _veilOk } : null;
}
const STILL_DELAY_S = 10;   // after his battle is on the canvas (the fall's rehearsal Workers start at ~6 s)
const _stillJobs = new Set();
/** A return, a fall or a crystal's death playing on this client. */
function showPlaying() {
  if (_shows.size) return true;
  try { if ((globalThis.__FU_NIDHOGG_FALL__?.shows?.() ?? []).some((sh) => !sh.finished)) return true; } catch { /* none */ }
  try { if (crystalDeathsPlaying()) return true; } catch { /* none */ }
  return false;
}
/**
 * The Boss Cycle transition's prepare (every client, while his battle is on this canvas): spec { bossTokenId }. The
 * still pieces, one a task in idle moments from STILL_DELAY_S on. -> release() (stops what is left; what is made stays).
 */
export function prepareNidhoggReturn(spec) {
  if (noStill() || typeof document === "undefined") return () => {};
  try { if (!shouldRender()) return () => {}; } catch { return () => {}; }
  const id = spec?.bossTokenId ?? null, tasks = stillTasks(() => (id ? canvas?.tokens?.get?.(id) : null));
  const job = { stop: false, timer: null, done: 0, ms: 0, worst: 0 };
  const idle = (fn) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 50));
  const run = () => {
    if (job.stop || !tasks.length) return;
    // never while a show plays on this client (its frames first): the rig caught a fall starting as they were made
    if (showPlaying()) { job.timer = setTimeout(() => { job.timer = null; idle(run); }, 1000); return; }
    const t0 = performance.now();
    try { tasks.shift()(); } catch (e) { warn("nidhogg-return: a still piece could not be made ahead (made at the black)", e); tasks.length = 0; }
    const ms = performance.now() - t0;
    job.done++; job.ms += ms; job.worst = Math.max(job.worst, ms);
    if (tasks.length) { idle(run); return; }
    _stillJobs.delete(job); _lastStill = { tasks: job.done, ms: +job.ms.toFixed(1), worst: +job.worst.toFixed(1) };
    log(`nidhogg-return: phase 2's still pieces made ahead (${job.done} tasks, ${job.ms.toFixed(1)} ms, worst ${job.worst.toFixed(1)} ms)`);
  };
  _stillJobs.add(job);
  job.timer = setTimeout(() => { job.timer = null; idle(run); }, STILL_DELAY_S * 1000);
  return () => { job.stop = true; clearTimeout(job.timer); _stillJobs.delete(job); };
}
let _lastStill = null;
/**
 * Rigs: are the still pieces made ahead the pixels a fresh build makes now? His pixels and glow compared byte for byte;
 * every canvas compared by what its TEXTURE holds on the GPU (drawn 1:1 into a render texture, read back, FNV-hashed):
 * a canvas' own getImageData is not that (Chrome moves a GPU canvas to the CPU once it has been uploaded, and the two
 * round a premultiplied low-alpha pixel differently on readback, while the textures made of either are the same;
 * measured 2026-11-17, tools/staging-world/canvas-determinism-probe.mjs). -> { compared, differ: [names] } | null.
 */
function stillCheck(t) {
  const e = t ? stillOf(paintedTexture(t)) : null;
  if (!e) return null;
  const h = (d) => { let x = 0x811c9dc5; for (let i = 0; i < d.length; i++) { x ^= d[i]; x = Math.imul(x, 0x01000193); } return x >>> 0; };
  const r = canvas.app.renderer;
  const gpu = (c, linear) => {
    const tx = textureOf(c, linear), sp = new PIXI.Sprite(tx), rt = PIXI.RenderTexture.create({ width: tx.width, height: tx.height });
    r.render(sp, { renderTexture: rt, clear: true });
    const px = r.extract.pixels(rt);
    sp.destroy(); rt.destroy(true); tx.destroy(true);
    return h(px);
  };
  const differ = [];
  let compared = 0;
  const same = (a, b, name) => { compared++; if (a !== b) differ.push(name); };
  const img = spritePixels(paintedTexture(t));
  same(e.img.data.length === img.data.length ? h(e.img.data) : -1, h(img.data), "img");
  for (const [k, q] of e.parts) {
    const g = glowPart(img, k);
    if (!q || !g) { compared++; if (!!q !== !!g) differ.push(`part ${k}`); continue; }
    same(h(q.g.data), h(g.data), `glow ${k}`);
    const pc = canvasOf(g.w, g.h, g.data);
    q.halos.forEach((c, i) => same(gpu(c, true), gpu(haloCanvas(pc, HALO[i].blur), true), `halo ${k} ${HALO[i].blur}`));
    same(gpu(q.pc, false), gpu(pc, false), `canvas ${k}`);
  }
  if (_dimCanvas) same(gpu(_dimCanvas, true), gpu(canvasOf(DIM_TEX, DIM_TEX, dimPixels(DIM_TEX)), true), "dim");
  return { compared, differ };
}
/** One texture per canvas (owned by the show, destroyed with it; `new BaseTexture` keeps it out of PIXI's cache). */
function textureOf(c, linear) {
  const base = new PIXI.BaseTexture(c, { scaleMode: linear ? PIXI.SCALE_MODES.LINEAR : PIXI.SCALE_MODES.NEAREST });
  return new PIXI.Texture(base);
}

/** A buffer sprite whose own buffer was painted in place: upload (the last box U this one), as takeFrame without the copy. */
function markFrame(s, rect) {
  const p = s.last, u = rect && p ? [Math.min(rect[0], p[0]), Math.min(rect[1], p[1]), Math.max(rect[2], p[2]), Math.max(rect[3], p[3])] : (rect ?? p);
  s.last = rect;
  if (u) s.res.dirty(u);
}

export class NidhoggReturnShow {
  /**
   * dragon: his token; crystalTokenId: the core's token (drawn by crystal-runtime); plan: { len, pause, doneAt }
   * (returnPlan's inputs); clock: () => ms (performance.now by default; rigs step it); startAt: s already gone.
   */
  constructor({ dragon, crystalTokenId, plan = null, clock = null, startAt = 0, specId = null, startedAt = null, opening = null }) {
    this.dragon = dragon; this.dragonId = dragon?.id ?? null; this.crystalTokenId = crystalTokenId ?? null;
    // OPENING MODE (the battle opening's roar, nidhogg-awakening-show.js, 2026-11-19): only the smoke and its blast.
    //   live   his body in the smoke is his LIVE 3D rig frame (the opening plays the rig's roar under it), not the
    //          painting; the rig keeps rendering while his token is hidden (keepRigLive)
    //   camera / hud   false = the caller owns them (the opening's 35-degree shot, its own HUD hold)
    //   glow / rings / look   false = no glowing parts, no rings, no closing look (they are laid on the PAINTING: on a
    //          turned live rig they would float off him); the show ends with the smoke (P.clear + 0.6)
    const op = opening && typeof opening === "object" ? opening : null;
    this.op = op ? { live: !!op.live, camera: op.camera !== false, hud: op.hud !== false, glow: op.glow !== false, rings: op.rings !== false, look: op.look !== false } : null;
    if (this.op?.live) {
      try { this.releaseLive = keepRigLive(dragon); } catch { this.releaseLive = null; }
    } else {
      // a 3D creature rig holds his painted pose through the show (whenRig: one still building is parked once it is up)
      try { whenRig(dragon, 3000).then((r) => { if (!this.finished) r?.rest(0); }).catch(() => {}); } catch { /* none */ }
    }
    this.specId = specId; this.startedAt = Number(startedAt) > 0 ? Number(startedAt) : null;
    this.P = planOf(plan);
    this.end = this.op && !this.op.look ? this.P.clear + 0.6 : this.P.end;
    this.clock = clock ?? (() => performance.now());
    // WP7: a client that starts late (joined / reloaded / canvas redrawn mid-show) starts at that second of the GM's
    // clock: its first frame is already that second's phase, HUD level, crystal, camera (#camera) and smoke
    this.startAt = Math.max(0, Number(startAt) || 0);
    this.t0 = this.clock() - this.startAt * 1000;
    this.finished = false;
    this.done = new Promise((r) => { this.resolveDone = r; });
    this.state = this.#st(this.startAt);
    // the sound: the user's picks (returnSfx / returnBed); a late start skips what it jumped past (the cue rule)
    this.cues = makeCueTrack(returnSfx(this.P).filter((c) => !this.op || this.op.look || c.beat <= this.P.pierce)); this.bedSpec = returnBed(this.P); this.bed = null;
    this.flips = [];   // rigs: [phase, D] as each phase begins on this client
    this.fxHz = Number(getClientOption("fxFrameRate")) === 30 ? 30 : 60;
    this.starTick = -1; this.starS = 0;
    this.p2 = null; this.p2Tried = false;   // phase 2's composition, built at the black (#prep)

    // no turn's floor light under the crystal: phase 1 ends on black (the return runs between turns anyway)
    try { this.releaseGlow = holdTurnGlowOff(); } catch { /* none */ }

    // the crystal: this show draws it until its end (the core goes out of play at `hidden` meanwhile)
    if (this.crystalTokenId) this.releaseCrystal = holdCrystal(this.crystalTokenId, () => this.#crystalState());
    // the arena: black until the reveal (the Crystal Round's void, held by the show as well as by the state)
    this.releaseVoid = holdArenaVoid(NAME);
    // the HUD: hidden for the whole show, driven from this clock
    //   (the curtain's own safety lets go after maxS of WALL clock: on a stepped clock (rigs) the show's clock is not the
    //   wall's, so it gets the long one; on the real clock the show's own guard below finishes it in time anyway)
    //   (starts at the level of the second it starts at: a late joiner's HUD is gone from its first frame)
    this.hud = this.op && !this.op.hud ? null : hideHud(NAME, { level: this.state.hud, maxS: clock ? 3600 : this.end + 30 });
    // the camera (driven from the black to the end of the pull-back; #camera)
    this.cam = null;
    // his sprite leaves the show container (for his own depth, his shadow fading in under him) once the smoke is gone
    // AND his look is over: the look's dark lies over him in the container, as in the mockup
    this.topAt = this.op && !this.op.look ? this.P.clear : Math.max(this.P.clear, this.P.look + CLOSE.up + CLOSE.hold + CLOSE.down);
    // the show's container, just above the backdrop and the void plate, under every battler
    try { this.#makeRoot(); } catch (e) { warn("nidhogg-return: the show layer could not start (the rest plays)", e); this.root = null; }
    // the soul's last light, at the crystal's heart
    try { this.star = new StarLayer(); } catch (e) { warn("nidhogg-return: the star layer could not start", e); this.star = null; }

    // real-time guard: a stalled ticker (hidden window) must not strand it
    if (!clock) this.timer = setTimeout(() => this.finish(), (this.end - Math.max(0, Number(startAt) || 0) + 3) * 1000);
    log(`nidhogg-return: the return begins (${dragon?.name ?? "no dragon"}, ${this.end.toFixed(2)} s)`);
  }

  #makeRoot() {
    const prim = canvas.primary, bg = prim?.background;
    if (!prim) { this.root = null; return; }
    const r = new PIXI.Container();
    r.name = "fud-nidhogg-return"; r.eventMode = "none";
    r.elevation = bg?.elevation ?? -Infinity; r.sortLayer = bg?.sortLayer ?? 0; r.sort = (bg?.sort || 0) + 3; r.zIndex = 0;
    r.visible = false;
    const box = (name) => { const c = new PIXI.Container(); c.name = `fud-nidhogg-return:${name}`; c.eventMode = "none"; return c; };
    const plate = () => { const s = new PIXI.Sprite(PIXI.Texture.WHITE); s.tint = 0x000000; s.eventMode = "none"; s.visible = false; return s; };
    // the fallback's flat dark (no phase 2 composition)
    this.dark = plate();
    // the window outside the smoke's buffers, black while the veil reaches their edge
    this.outer = [plate(), plate(), plate(), plate()];
    // the draw order (the mockup's): veil + back smoke | his sprite | front smoke | his glowing parts | the rings |
    // his look (the eye's burst, the dark round the edges) | the flash. fx*: the smoke's frame (canvas px); spr*: his sprite px, on his mesh's rect
    this.fxBack = box("smoke-back"); this.sprBody = box("body"); this.fxFront = box("smoke-front");
    this.sprGlow = box("glow"); this.fxRings = box("rings"); this.look = box("look");
    // his look (WP5): the eye's burst (the smoke's frame, like the rings) under the dark round the screen's edges
    this.lookFire = box("look-fire"); this.lookFire.visible = false;
    this.look.addChild(this.lookFire);
    this.flash = plate(); this.flash.tint = 0xdcffe2;
    // his sprite from the clear on (the smoke is gone): at his OWN depth, right after his mesh, so his floor shadow
    // (sorted just under his mesh) fades in UNDER him before the hand-back (measured on the rig: the shadow popping in
    // whole was the only change over him at the hand-back). Not in the show container: placeAfter sorts it.
    this.bodyTop = box("body-top"); this.bodyTop.visible = false;
    prim.addChild(this.bodyTop);
    r.addChild(this.dark, ...this.outer, this.fxBack, this.sprBody, this.fxFront, this.sprGlow, this.fxRings, this.look, this.flash);
    prim.addChild(r);
    prim.sortDirty = true;
    this.root = r;
  }

  /**
   * Phase 2, built once at the black (nothing moves on screen then): his pixels, the stage laid on his drawn sprite,
   * the smoke painter (its first frame, tau 0, before the roar), his parts + halos, the rings' frame, his sprite.
   * Null (the fallback plays) without his token, its rect or its pixels.
   */
  #prep() {
    this.p2Tried = true;
    const t = this.dragon, R = t && !t.destroyed && t.mesh ? drawnRect(t) : null;
    if (!R || !(R.w > 0) || !this.root) return null;
    // the painting, not a live 3D rig frame; his pixels and parts' canvases made ahead when they were (stillOf)
    const t0 = performance.now(), tex = paintedTexture(t), pre = stillOf(tex, true), img = pre ? pre.img : spritePixels(tex);
    if (!img) return null;
    // (rigs) where the build's time goes: ms per step
    const by = {}; let tm = t0; const mark = (k) => { const n = performance.now(); by[k] = +(n - tm).toFixed(1); tm = n; };
    mark("img");
    const mirrored = (t.mesh.scale?.x ?? 1) < 0, F = frameOn(stageOf(canvas.scene));
    const rect = { x: (R.x - F.x) / F.k, y: (R.y - F.y) / F.k, w: R.w / F.k, h: R.h / F.k };
    const stage = returnStage(img, rect, mirrored ? 1 : -1);
    mark("stage");
    const owned = [];   // textures this show made (destroyed with it)
    const p2 = { F, R0: { ...R }, R: { ...R }, mirrored, stage, img: { width: img.width, height: img.height }, owned, parts: [], ringTick: null, smokeTick: null, smokeDead: false };
    // the smoke
    try {
      p2.smoke = new SmokeLayer(stage.smoke, { tauNow: () => ({ tau: this.D() - this.P.pierce, view: this.p2?.view ?? null, now: this.clock() }) });
      this.fxBack.addChild(p2.smoke.sp.veil.sp, p2.smoke.sp.back.sp);
      this.fxFront.addChild(p2.smoke.sp.front.sp);
    } catch (e) { warn("nidhogg-return: the smoke could not start (he fades in instead)", e); p2.smoke = null; p2.smokeDead = true; }
    mark("smoke");
    // his sprite: his token's own texture (the hand-back draws the same pixels)
    p2.body = new PIXI.Sprite(this.op?.live ? (t.mesh.texture ?? tex) : tex); p2.body.eventMode = "none"; p2.body.visible = false;
    this.sprBody.addChild(p2.body);
    // his glowing parts: halo (wide), halo (tight) added, then the pixels themselves, per part
    by.still = pre ? Object.fromEntries([...pre.parts].map(([k, q]) => [k, q ? q.halos.length : null])) : null;
    for (const k of (this.op && !this.op.glow ? [] : PART_KEYS)) {
      const q = pre ? stillPart(pre, k) : null, g = q ? q.g : pre ? null : glowPart(img, k);
      if (!g) continue;
      const pc = q ? q.pc : canvasOf(g.w, g.h, g.data), pt = textureOf(pc, false);
      owned.push(pt);
      const halos = HALO.map((h, i) => {
        const hc = q ? q.halos[i] : haloCanvas(pc, h.blur);
        const ht = textureOf(hc, true); owned.push(ht);
        const s = new PIXI.Sprite(ht); s.eventMode = "none"; s.blendMode = PIXI.BLEND_MODES.ADD; s.position.set(g.x0 - HPAD, g.y0 - HPAD); s.visible = false;
        return { s, a: h.a };
      });
      const pix = new PIXI.Sprite(pt); pix.eventMode = "none"; pix.position.set(g.x0, g.y0); pix.visible = false;
      for (const h of halos) this.sprGlow.addChild(h.s);
      this.sprGlow.addChild(pix);
      p2.parts.push({ k, halos, pix });
    }
    mark("parts");
    // the rings: a frame round his mouth (buffer px), painted here. WP6: painted straight into the textures' own
    // buffers, only inside the rings' box (ringsBox), no premultiply (ring pixels are opaque: it is the identity)
    const { W: RW, H: RH } = RING_FRAME, rox = Math.round(stage.ring.x) - RW / 2, roy = Math.round(stage.ring.y) - RH / 2;
    const rcS = bufferSprite(RW, RH), rlS = bufferSprite(RW, RH), direct = !preWP6();
    p2.rings = { direct, box: null, color: rcS, light: rlS, tau: null, frames: 0, empty: true,
      frame: direct ? { w: RW, h: RH, ox: rox, oy: roy, color: new Uint32Array(rcS.u8.buffer), light: new Uint32Array(rlS.u8.buffer) } : createFrame(RW, RH, rox, roy),
      c: direct ? null : new Uint32Array(RW * RH), l: direct ? null : new Uint32Array(RW * RH) };
    p2.rings.light.sp.blendMode = PIXI.BLEND_MODES.ADD;
    for (const s of [p2.rings.color.sp, p2.rings.light.sp]) { s.eventMode = "none"; s.position.set((p2.rings.frame.ox - MG) * PX, (p2.rings.frame.oy - MG) * PX); s.scale.set(PX); this.fxRings.addChild(s); }
    this.fxRings.visible = false;
    mark("rings");
    // his look: the burst's frame round his eye (effect px), painted here
    const lo = lookFrameAt(stage.eye, stage.facing), { W: LW, H: LH } = LOOK_FRAME;
    // (WP6: premultiplied straight into the textures' own buffers, no copy)
    const fcS = bufferSprite(LW, LH), flS = bufferSprite(LW, LH);
    p2.fire = { frame: createFrame(LW, LH, lo.ox, lo.oy), c: new Uint32Array(fcS.u8.buffer), l: new Uint32Array(flS.u8.buffer),
      color: fcS, light: flS, u: null, tick: null, frames: 0, empty: true };
    p2.fire.light.sp.blendMode = PIXI.BLEND_MODES.ADD;
    for (const s of [p2.fire.color.sp, p2.fire.light.sp]) { s.eventMode = "none"; s.position.set(lo.ox * PX, lo.oy * PX); s.scale.set(PX); this.lookFire.addChild(s); }
    // the dark round the screen's edges: one texture, centred on his head every frame
    const dt = textureOf(dimCanvas(), true); owned.push(dt);
    p2.dim = new PIXI.Sprite(dt); p2.dim.eventMode = "none"; p2.dim.anchor.set(0.5); p2.dim.visible = false;
    this.look.addChild(p2.dim);
    mark("lookDim");
    // his head on his 2D spot (scene px): the camera aims it (the 3D camera draws him elsewhere: #camera corrects)
    p2.face2D = this.#face2D(t, stage.faceUV, mirrored, img) ?? pointOn(R, stage.faceUV, mirrored, img.width, img.height);
    // the floor the smoke lies on (scene px, his feet first): fitted each frame to where the 3D camera draws it (#placeFx)
    //   (opening mode: NOT fitted to the floor. The opening's camera is a placed shot turned far round him, where the
    //   floor fit skews the smoke's frame off the screen; its 2D view stays on the battle framing, so the frame laid
    //   flat on the window is the whole screen, his billows built on where he is drawn now)
    p2.floorPts = this.op ? null : floorPoints(stageOf(canvas.scene), { x: t.document.x + t.w / 2, y: t.document.y + t.h });
    p2.drawnHook = Hooks.on(DRAWN_HOOK, () => { try { this.#onDrawn(); } catch (e) { warn("nidhogg-return: placing on the 3D frame threw", e); } });
    mark("place");
    p2.prepMs = +(performance.now() - t0).toFixed(1); p2.prepBy = by;
    log(`nidhogg-return: phase 2 ready (${p2.prepMs} ms; ${stage.smoke.body.lobes.length} billows over him, ${p2.parts.length} parts)`);
    return p2;
  }

  /** His head on his token's 2D spot (scene px): the mesh's own bounds, read outside a render (the 3D camera moves the
   *  mesh only inside one). Null without them. */
  #face2D(t, uv, mirrored, img) {
    const b = t?.mesh?.getBounds?.();
    if (!b || !(b.width > 0)) return null;
    const wt = canvas.stage.worldTransform, a = wt.applyInverse(new PIXI.Point(b.x, b.y)), c = wt.applyInverse(new PIXI.Point(b.x + b.width, b.y + b.height));
    const R = { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) };
    return pointOn(R, uv, mirrored, img.width, img.height);
  }

  /**
   * His sprite and the effect frames laid where they are drawn this frame (R: his drawn rect, scene px). His sprite
   * on R. Flat (no 3D camera drawing): the frames ride his drawn rect (a shift), as built. Under the 3D camera the
   * floor is drawn through the camera's projection, not the 2D canvas: the smoke's frame gets the affine that best
   * carries the stage's floor (2D) onto the drawn floor (projectFoot), exact at his feet, so it lies on the floor;
   * the rings and his eye's burst are his own (round his mouth / eye): they ride his drawn sprite (R0 -> R).
   */
  #placeFx(R) {
    const p2 = this.p2, F = p2.F, S3 = globalThis.__ONI_BATTLE_STAGE_3D__;
    let floor = null, him = null;
    if (p2.floorPts && S3?.cameraLive?.() && S3.projectFoot) {
      floor = fitFloor(p2.floorPts, p2.floorPts.map((q) => S3.projectFoot(q)));
      if (floor) him = rectMap(p2.R0, R);
    }
    if (!floor) floor = him = shiftOf(R.x - p2.R0.x, R.y - p2.R0.y);
    p2.fit = floor !== him;
    p2.fxSmoke = frameMatrix(floor, F); p2.fxHim = frameMatrix(him, F);
    setMatrix(this.fxBack, p2.fxSmoke); setMatrix(this.fxFront, p2.fxSmoke);
    setMatrix(this.fxRings, p2.fxHim); setMatrix(this.lookFire, p2.fxHim);
    const W = p2.img.width, H = p2.img.height;
    for (const c of [this.sprBody, this.sprGlow, this.bodyTop]) {
      if (p2.mirrored) { c.position.set(R.x + R.w, R.y); c.scale.set(-R.w / W, R.h / H); }
      else { c.position.set(R.x, R.y); c.scale.set(R.w / W, R.h / H); }
    }
  }

  /** The 3D camera has laid out this frame (its rig + his mesh moved, before the scene is drawn): placed again on it,
   *  so nothing lags the camera by a frame (the show steps before the render, on the last frame's rig). */
  #onDrawn() {
    const p2 = this.p2, t = this.dragon;
    if (!p2 || this.finished || !this.root || this.root.destroyed || !this.root.visible) return;
    const R = t && !t.destroyed && t.mesh ? drawnRect(t) ?? p2.R : p2.R;
    p2.R = R;
    this.#placeFx(R);
  }

  /**
   * The camera (the mockup's camAt): from the black it pushes in on his head (2.0x, at 0.42 of the screen, creeping
   * to 2.12x by the roar), then at the roar pulls back past the battle framing (0.92x in 0.5 s) and eases back onto it
   * by tau 1.5. Driven here every frame through the 2D view (canvas.pan); the 3D camera follows the 2D view (a dolly
   * + truck, the floor under the view centre held), so it is CLAIMED for the show (no hold folds it to neutral
   * meanwhile), and the player's camera fence is suspended (the pull-back goes past the rest framing). Under the 3D
   * camera his head is drawn off its 2D spot: the view is nudged by that offset (predictDrawn, a few fixed-point steps)
   * so his DRAWN head lands where the mockup puts it. Lands exactly on the rest view; let go at finish().
   */
  #camera(s) {
    const P = this.P;
    if (this.cam?.landed || s.T < P.black) return;
    if (!this.cam) {
      if (!canvas?.ready) return;
      if (s.tau >= CAMF.back) {
        // (WP7) started after the pull-back (a late joiner): nothing to drive, the camera is where the move left it,
        // on the rest view; no claim, no fence suspended
        const rest = restViewFor(canvas.scene);
        this.cam = { sceneId: canvas.scene?.id ?? null, rest, landed: true, released: true, late: true, frames: 0, maxErr: 0, view: rest ? { ...rest } : null };
        if (rest) { try { canvas.pan({ x: rest.x, y: rest.y, scale: rest.scale }); } catch { /* gone */ } }
        return;
      }
      const scene = canvas.scene, F = frameOn(stageOf(scene));
      const c = this.cam = { sceneId: scene?.id ?? null, rest: restViewFor(scene), F, landed: false, frames: 0, maxErr: 0 };
      try { c.releaseClaim = stage3d()?.camera?.claim?.(NAME) ?? null; } catch { c.releaseClaim = null; }
      try { c.resume = suspendCamera(); } catch { c.resume = null; }
    }
    const c = this.cam;
    if (!canvas?.ready || canvas.scene?.id !== c.sceneId) return;
    if (s.tau >= CAMF.back) {
      try { canvas.pan({ x: c.rest.x, y: c.rest.y, scale: c.rest.scale }); } catch { /* gone */ }
      c.landed = true; c.view = { ...c.rest };
      return;
    }
    // his head: on his 2D spot (built at the black), else the mockup's spot on the frame
    const face = this.p2?.face2D ?? { x: c.F.x + c.F.k * CAMF.face.x, y: c.F.y + c.F.k * CAMF.face.y };
    const v0 = returnView(s.cam, { rest: c.rest, F: c.F, face });
    let v = v0;
    const S3 = globalThis.__ONI_BATTLE_STAGE_3D__, t = this.dragon, k = s.cam.k;
    if (k > 0 && S3?.predictDrawn && t && !t.destroyed && this.p2?.face2D) {
      for (let i = 0; i < 4; i++) {
        const d = S3.predictDrawn(t, face, v);
        if (!d) break;
        const nv = { x: v0.x + k * (d.x - face.x), y: v0.y + k * (d.y - face.y), scale: v0.scale };
        const moved = Math.hypot(nv.x - v.x, nv.y - v.y);
        v = nv;
        if (moved < 0.05) break;
      }
      // (rigs: how far his drawn head sits from its aim with the nudged view)
      const d = S3.predictDrawn(t, face, v);
      if (d) { const ex = ((d.x - v.x) - (face.x - v0.x)) * v.scale, ey = ((d.y - v.y) - (face.y - v0.y)) * v.scale; c.err = [+ex.toFixed(2), +ey.toFixed(2)]; c.maxErr = Math.max(c.maxErr, k * Math.hypot(ex, ey)); }
    }
    try { canvas.pan({ x: v.x, y: v.y, scale: v.scale }); } catch { /* gone */ }
    c.view = v; c.frames++;
  }

  /**
   * The camera handed back: on the rest view if it had not landed; the 3D camera's claim and the fence let go.
   * WP7: torn down mid-drive (canvasTearDown: Foundry has already marked the canvas not ready, so a pan is not the
   * lever) the scene's remembered view (Scene#_viewPosition, what its next draw opens on, Canvas
   * initializeCanvasPosition) is set to the rest view, so a redraw never opens pushed in on his head.
   */
  #releaseCamera() {
    const c = this.cam;
    if (!c || c.released) return;
    c.released = true;
    if (!c.landed && c.rest) {
      const v = { x: c.rest.x, y: c.rest.y, scale: c.rest.scale };
      if (canvas?.ready && canvas.scene?.id === c.sceneId) { try { canvas.pan(v); } catch { /* gone */ } }
      else { try { const sc = game.scenes?.get(c.sceneId); if (sc) sc._viewPosition = v; } catch { /* gone */ } }
      c.landed = true; c.torn = !canvas?.ready; c.view = { ...v };
    }
    try { c.releaseClaim?.(); } catch { /* gone */ }
    try { c.resume?.(); } catch { /* gone */ }
  }

  /** Phase 2's layers this frame (from the black on; s = returnState). */
  #phase2(s) {
    const p2 = this.p2, t = this.dragon;
    // where he is drawn now (his idle sway moves him a few px): the frame rides with him
    const R = t && !t.destroyed && t.mesh ? drawnRect(t) ?? p2.R : p2.R;
    p2.R = R;
    const F = p2.F, W = p2.img.width, H = p2.img.height;
    this.#placeFx(R);
    // the visible window (scene px), and the part of the buffers on screen (the window's corners back in the frame)
    const st = canvas.stage, scr = canvas.app.renderer.screen, k = st.scale.x || 1;
    const win = { x: st.pivot.x - scr.width / (2 * k), y: st.pivot.y - scr.height / (2 * k), w: scr.width / k, h: scr.height / k };
    const M = p2.fxSmoke, cs = [[win.x, win.y], [win.x + win.w, win.y], [win.x, win.y + win.h], [win.x + win.w, win.y + win.h]].map(([x, y]) => unmapPoint(M, { x, y }) ?? { x: (x - F.x) / F.k, y: (y - F.y) / F.k });
    const view = viewOf(Math.min(...cs.map((c) => c.x)), Math.min(...cs.map((c) => c.y)), Math.max(...cs.map((c) => c.x)), Math.max(...cs.map((c) => c.y)));
    p2.view = view;

    // ── the smoke: its first frame (tau 0, the veil whole) before the roar, then at the smoke's rate ──
    const sm = p2.smoke;
    if (sm && !sm.dropped) {
      if (s.tau >= 0 && !s.smoke) { sm.drop(); }
      else {
        // before the roar: its tau-0 frame, once; from it on: at the client's frame rate (smokeHz, at most), due-timed
        const tau = Math.max(0, s.tau);
        if (s.tau < 0 || preWP6()) {
          const tick = s.tau < 0 ? -1 : Math.floor(s.tau * this.P.smokeHz);
          if (tick !== p2.smokeTick || (s.tau < 0 && sm.tau !== 0)) { if (sm.request(tau, view)) p2.smokeTick = tick; }
          // the quiet seconds before the roar, its tau-0 frame up: warm the painters' JIT on the roar's frames
          else if (s.tau < 0 && sm.tau === 0) sm.warm(s.tau, view);
        } else sm.want(tau, view, this.clock(), Math.min(this.fxHz, this.P.smokeHz));
      }
    }
    const smokeUp = !!sm && sm.shown && !sm.dropped;
    if (smokeUp) sm.follow(view);
    this.fxBack.visible = this.fxFront.visible = smokeUp;
    if (sm?.errors > 3 && !sm.shown) p2.smokeDead = true;

    // ── his sprite: from the roar, only under the smoke that hides him (or fading in if there is no smoke); at his own
    //    depth once the smoke is gone and his look is over ──
    const b = p2.body, top = s.T >= this.topAt && !!t?.mesh && !t.destroyed;
    if (top && b.parent !== this.bodyTop) this.bodyTop.addChild(b);
    else if (!top && b.parent !== this.sprBody) this.sprBody.addChild(b);
    this.bodyTop.visible = top;
    if (top) placeAfter(this.bodyTop, t.mesh);
    p2.shadow = top ? smooth(this.topAt, this.end - 0.15, s.T) : 0;
    // (opening mode) his live rig frame: the texture his mesh shows now, sized as the painting
    if (this.op?.live && t?.mesh && !t.destroyed) {
      const lt = t.mesh.texture;
      if (lt && lt !== PIXI.Texture.EMPTY && lt.valid !== false && b.texture !== lt) b.texture = lt;
      if (b.texture?.orig?.width) { b.width = W; b.height = H; }
    }
    b.visible = s.tau > 0 && (smokeUp || p2.smokeDead || (sm?.dropped ?? false));
    b.alpha = (t?.alpha ?? 1) * (smokeUp || sm?.dropped ? 1 : smooth(this.P.pierce, this.P.clear, s.T));

    // ── his glowing parts: up out of the dark together, the wind-up, the roar's burst, gone once he is uncovered; then
    //    in his look, his eye and mouth burn up again and throb twice ──
    const gl = s.glow, lg = s.lookU != null ? lookGlow(s.look, s.throb) : null;
    for (const p of p2.parts) {
      if (lg) {
        const a = lg[p.k] ?? [0, 0, 0];
        p.halos.forEach((h, i) => { h.s.alpha = a[i] ?? 0; h.s.visible = h.s.alpha > 0; });
        p.pix.alpha = a[2]; p.pix.visible = a[2] > 0;
        continue;
      }
      const L = gl ? gl[p.k] : 0, on = L > 0.004;
      for (const h of p.halos) { h.s.visible = on; h.s.alpha = h.a * L; }
      p.pix.visible = on; p.pix.alpha = Math.min(1, L);
    }

    // ── his look: his eye bursts into flame (painted here at the smoke's rate), the dark closes in round the edges ──
    const fi = p2.fire;
    if (s.burstF != null && s.burstF >= 0 && s.burstF <= 2) {
      const tick = Math.floor(s.lookU * this.P.ringHz);
      if (tick !== fi.tick) {
        fi.tick = tick;
        const f = fi.frame;
        clearFrame(f);
        eyeBurst(painterFor(f), s.lookU, p2.stage.eye, this.P.burstN, p2.stage.facing);
        const cR = premultiply(f.color, fi.c, f.w, f.h), lR = premultiply(f.light, fi.l, f.w, f.h);
        markFrame(fi.color, cR); markFrame(fi.light, lR);
        fi.empty = !cR && !lR; fi.u = s.lookU; fi.frames++;
      }
      this.lookFire.visible = !fi.empty;
    } else this.lookFire.visible = false;
    const dm = p2.dim;
    dm.visible = s.look > 0.004;
    if (dm.visible) {
      // on the screen (mockup px), centred on his head where he is drawn; the camera's scale shrinks it back to screen
      const head = pointOn(R, p2.stage.faceUV, p2.mirrored, W, H), reach = 2 * DIM.r1 * F.k / (s.cam.s || 1);
      dm.position.set(head.x, head.y); dm.scale.set(reach / (DIM_TEX / 2)); dm.alpha = CLOSE.dim * s.look;
    }

    // ── the roar's rings, painted here at the smoke's rate ──
    const rg = p2.rings;
    if (s.rings) {
      const tick = Math.floor(s.tau * this.P.ringHz);
      if (tick !== p2.ringTick) {
        p2.ringTick = tick;
        const f = rg.frame;
        if (rg.direct) {
          // the last frame's box cleared (nothing lies outside it), this one painted inside its box, both boxes uploaded
          const box = ringsBox(s.tau, p2.stage.ring.x, p2.stage.ring.y, f.w, f.h, f.ox, f.oy), last = rg.box;
          if (last) { f.color.fill(0, last[1] * f.w, (last[3] + 1) * f.w); f.light.fill(0, last[1] * f.w, (last[3] + 1) * f.w); }
          if (box) paintRings(painterFor(f), s.tau, p2.stage.ring.x, p2.stage.ring.y, p2.stage.facing);
          markFrame(rg.color, box); markFrame(rg.light, box);
          rg.box = box; rg.empty = !box;
        } else {
          clearFrame(f);
          paintRings(painterFor(f), s.tau, p2.stage.ring.x, p2.stage.ring.y, p2.stage.facing);
          const cR = premultiply(f.color, rg.c, f.w, f.h), lR = premultiply(f.light, rg.l, f.w, f.h);
          takeFrame(rg.color, rg.c.buffer, cR, f.w); takeFrame(rg.light, rg.l.buffer, lR, f.w);
          rg.empty = !cR && !lR;
        }
        rg.tau = s.tau; rg.frames++;
      }
      this.fxRings.visible = !rg.empty;
    } else this.fxRings.visible = false;

    // ── the window outside the buffers: black while the veil reaches their edge ──
    const outerOn = smokeUp && sm.veilAtEdge();
    // (the buffers' quad on the scene; under the 3D fit a slightly skewed one: the plates take its inner bounds and
    //  overlap the veil's own black edge a little rather than leave a sliver)
    const bW = sm ? sm.W * PX : 0, bH = sm ? sm.H * PX : 0, q0 = -MG * PX;
    const bq = [[q0, q0], [q0 + bW, q0], [q0, q0 + bH], [q0 + bW, q0 + bH]].map(([x, y]) => mapPoint(M, { x, y }));
    const bx = Math.max(bq[0].x, bq[2].x), by = Math.max(bq[0].y, bq[1].y), bw = sm ? Math.min(bq[1].x, bq[3].x) - bx : 0, bh = sm ? Math.min(bq[2].y, bq[3].y) - by : 0;
    const pad = PAD_SCREEN / k, X0 = win.x - pad, Y0 = win.y - pad, X1 = win.x + win.w + pad, Y1 = win.y + win.h + pad;
    const rects = [[X0, Y0, X1, by], [X0, by + bh, X1, Y1], [X0, by, bx, by + bh], [bx + bw, by, X1, by + bh]];
    this.outer.forEach((o, i) => {
      const [a, c, d, e] = rects[i], w = d - a, h = e - c;
      o.visible = outerOn && w > 0 && h > 0;
      if (o.visible) { o.position.set(a, c); o.width = w; o.height = h; }
    });

    // ── the break's flash (over the arena, under the battlers) ──
    this.flash.visible = s.flash > 0;
    if (this.flash.visible) { this.flash.position.set(X0, Y0); this.flash.width = X1 - X0; this.flash.height = Y1 - Y0; this.flash.alpha = s.flash; }
  }

  /**
   * The crystal while the dark closes in on it: drawn whole (it never moves, never fades), the Worker darkens it from
   * the front in; as the glass goes the soul burns brighter and shows more (the core stays bright). Gone (null) once
   * the core is: by then the front has closed it to black. Held this way it is drawn although the core went out of
   * play at `hidden` on the GM's clock (crystal-runtime: a show's hold wins over out-of-play).
   */
  #crystalState() {
    const c = this.state?.close;
    if (!c) return null;   // the core is gone
    const L = closeLook(c.lastK);
    return { alpha: 1, reveal: 1, opaque: 0, sweep: null, flameK: L.flameK, flameSee: L.flameSee, close: { front: c.front }, scale: 1, hitAge: null, debris: false };
  }

  /** The soul's last light: its strength from the clock, painted on the effects' tick, placed at the crystal's heart. */
  #star(s) {
    const L = this.star;
    this.starS = 0;
    if (!L || L.dropped) return;
    const g = glintAt(s.glintU), place = g && g.S > 0.015 && this.crystalTokenId ? crystalPlace(this.crystalTokenId) : null;
    if (!place) { L.root.visible = false; return; }
    const tick = Math.floor(s.T * this.fxHz);
    if (tick !== this.starTick) { this.starTick = tick; L.paint(g.S); }
    // the frame's middle pixel on the crystal's heart pixel (column CX, row HEART_ROW), at the crystal's drawn scale
    const k = place.px * place.m;
    L.root.position.set(place.feet.x - (STAR.W / 2) * k, place.feet.y + (HEART_ROW - FRAME.FLOOR - STAR.H / 2) * k);
    L.root.scale.set(k);
    const above = place.root ?? canvas.tokens.get(this.crystalTokenId)?.mesh;
    if (above) placeAfter(L.root, above);
    L.root.visible = !L.empty;
    this.starS = L.S;
  }

  /** The clock's state at D, with what opening mode leaves out taken out (returnState unchanged otherwise). */
  #st(D) {
    const s = returnState(D, this.P), op = this.op;
    if (!op) return s;
    if (!op.glow) s.glow = null;
    if (!op.rings) s.rings = false;
    if (!op.look) {
      s.lookU = null; s.look = 0; s.throb = 1; s.burstF = null;
      if (s.phase === "look") s.phase = s.T < this.P.clear ? "roar" : "after";
      s.done = s.T >= this.end;
      if (s.phase === "done" && !s.done) s.phase = "after";
      else if (s.done) s.phase = "done";
    }
    return s;
  }

  /** Seconds since the return began. */
  D() { return Math.max(0, (this.clock() - this.t0) / 1000); }
  /** Rigs: jump to return time D. */
  seek(D) { this.t0 = this.clock() - D * 1000; }

  /** Every display frame. */
  step() {
    if (this.finished) return;
    const D = this.D(), s = (this.state = this.#st(D));
    if (this.flips.at(-1)?.[0] !== s.phase) this.flips.push([s.phase, +D.toFixed(2)]);

    // ── sound ──
    this.cues.step(D, (c, url) => playSfx(url, c.vol));
    const bed = this.bedSpec, bv = bedVolume(bed, D);
    if (bv > 0 && !this.bed && D - bed.from < 0.5) this.bed = playBed(cueUrl(bed.file), { vol: bv, offset: D - bed.from });
    if (this.bed) { if (D >= bed.to) { this.bed.stop(); this.bed = null; } else this.bed.setVolume(bv); }

    // ── phase 1: the soul's last light (the crystal itself: #crystalState, read by its host) ──
    this.#star(s);

    // ── phase 2 (from the black): built once; the camera moved; then everything laid out in the frame's view ──
    const on2 = D >= this.P.black;
    if (on2 && !this.p2Tried && this.root && !this.root.destroyed) {
      try { this.p2 = this.#prep(); } catch (e) { warn("nidhogg-return: phase 2 could not be built (the fallback plays)", e); this.p2 = null; }
    }
    if (!this.op || this.op.camera) try { this.#camera(s); } catch (e) { warn("nidhogg-return: the camera could not move (it stays put)", e); this.#releaseCamera(); this.cam = { landed: true, released: true }; }
    if (this.root && !this.root.destroyed) {
      const on = on2;
      this.root.visible = on;
      if (on && this.p2) {
        this.dark.visible = false;
        this.#phase2(s);
      } else if (on) {
        // the fallback: flat dark from the black until the roar, thinning out to the clear
        const st = canvas.stage, scr = canvas.app.renderer.screen, k = st.scale.x || 1, pad = PAD_SCREEN / k;
        this.dark.position.set(st.pivot.x - scr.width / (2 * k) - pad, st.pivot.y - scr.height / (2 * k) - pad);
        this.dark.width = scr.width / k + 2 * pad; this.dark.height = scr.height / k + 2 * pad;
        this.dark.alpha = s.revealed ? 1 - smooth(this.P.pierce, this.P.clear, D) : 1;
        this.dark.visible = this.dark.alpha > 0.002;
      }
      // the shake moves only this container (screen px)
      const k = canvas.stage.scale.x || 1;
      this.root.position.set(s.shake.x / k, s.shake.y / k);
    }

    // ── the arena: lit from the reveal on, whatever the state says here yet; the void goes once the veil is over
    //    the arena (its first frame is up before the roar; a smoke that never came lets go after a moment) ──
    if (s.revealed && !this.releaseLit) {
      const sm = this.p2?.smoke, veilUp = !this.p2 || this.p2.smokeDead || !sm || sm.shown || s.tau > 1;
      if (veilUp) {
        this.releaseLit = holdArenaLit(NAME);
        try { this.releaseVoid?.(); } catch { /* gone */ }
        this.releaseVoid = null;
      }
    }

    // ── his token: hidden through the show (the out-of-play renderer lets go at the reveal; this keeps him). Phase 2
    //    draws his sprite in the show container; the fallback fades his mesh in as the dark thins ──
    const t = this.dragon;
    if (t && !t.destroyed && t.mesh) {
      const fade = !this.p2 && s.revealed ? smooth(this.P.pierce, this.P.clear, D) : 0;
      try { t.mesh.alpha = (t.alpha ?? 1) * fade; } catch { /* gone */ }
      for (const k of TOKEN_PARTS) { const o = t[k]; if (o && !o.destroyed && o.visible) o.visible = false; }
      holdShadow(t, this.p2?.shadow ?? 0);
    }

    // ── the HUD ──
    if (this.hud) setHudLevel(this.hud, s.hud);

    if (D >= this.end) this.finish();
  }

  /** Over (or torn down): everything put back; the states (in play, the lit arena) carry on. */
  finish() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    try { this.bed?.stop(); } catch { /* gone */ }
    this.bed = null;
    this.#releaseCamera();
    try { this.releaseCrystal?.(); } catch { /* gone */ }
    try { this.releaseVoid?.(); } catch { /* gone */ }
    try { this.releaseLit?.(); } catch { /* gone */ }
    try { this.releaseGlow?.(); } catch { /* gone */ }
    if (this.hud) showHud(this.hud, { fade: 0 });
    this.#dropPhase2();
    try { this.bodyTop?.parent?.removeChild(this.bodyTop); this.bodyTop?.destroy({ children: false }); } catch { /* gone */ }
    try { this.root?.parent?.removeChild(this.root); this.root?.destroy({ children: true }); } catch { /* gone */ }
    this.star?.drop();
    // his token goes back to Foundry (in play: drawn as usual from here on)
    const t = this.dragon;
    if (t && !t.destroyed) {
      try { if (t.mesh) t.mesh.alpha = t.alpha ?? 1; } catch { /* gone */ }
      holdShadow(t, 1);
      try { rigFor(t)?.release(); } catch { /* none */ }   // his 3D rig moves again
      try { this.releaseLive?.(); } catch { /* none */ }
      try { t.renderFlags?.set?.({ refreshState: true, refreshBars: true, refreshNameplate: true, refreshEffects: true, refreshVisibility: true }); } catch { /* older core */ }
    }
    _shows.delete(this);
    if (!_shows.size) stopTicker();
    this.resolveDone();
    log("nidhogg-return: the return is over");
  }

  status() {
    const s = this.state;
    return { D: +this.D().toFixed(2), end: +this.end.toFixed(3), startAt: +this.startAt.toFixed(2), specId: this.specId,
      // (WP7 rigs) this client's clock against the GM's: D minus the seconds since the GM's start (server time); ~0 = in step
      sync: this.startedAt ? +(this.D() - (serverNow() - this.startedAt) / 1000).toFixed(3) : null, phase: s.phase, beat: s.caption, hud: +s.hud.toFixed(3), lit: !!this.releaseLit,
      dark: this.dark && !this.dark.destroyed ? +this.dark.alpha.toFixed(3) : null, flips: this.flips.slice(), finished: this.finished,
      front: s.close ? +s.close.front.toFixed(4) : null, star: this.star ? { S: +this.starS.toFixed(4), shown: !!this.star.root?.visible, frames: this.star.frames } : null,
      p2: this.#p2Status(), cam: this.#camStatus() };
  }

  #camStatus() {
    const c = this.cam, s = this.state;
    if (!c) return null;
    const st = canvas?.stage, r = (v) => (v == null ? null : +Number(v).toFixed(3));
    return { s: r(s.cam.s), k: r(s.cam.k), frames: c.frames ?? 0, landed: !!c.landed, released: !!c.released, late: !!c.late, torn: !!c.torn, claimed: !!c.releaseClaim && !c.released, err: c.err ?? null, maxErr: r(c.maxErr),
      want: c.view ? { x: r(c.view.x), y: r(c.view.y), scale: r(c.view.scale) } : null, rest: c.rest ? { x: r(c.rest.x), y: r(c.rest.y), scale: r(c.rest.scale) } : null,
      view: st ? { x: r(st.pivot.x), y: r(st.pivot.y), scale: r(st.scale.x) } : null };
  }

  #p2Status() {
    const p = this.p2;
    if (!p) return this.p2Tried ? { failed: true } : null;
    const r = (o) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(2) : v]));
    const sm = p.smoke;
    return {
      prepMs: p.prepMs, prepBy: p.prepBy ?? null, mirrored: p.mirrored, R: r(p.R), fit: !!p.fit, frame: r(p.F), rect: r(p.stage.rect), mouth: r(p.stage.mouth), view: p.view ?? null,
      smoke: sm ? { ready: sm.ready, shown: sm.shown, frames: sm.frames, tau: sm.tau, inflight: sm.inflight, dropped: sm.dropped, ms: +sm.ms.toFixed(1), worst: +sm.worst.toFixed(1), veilEdge: sm.veilAtEdge(), errors: sm.errors ?? 0, ...(sm.parts ? sm.lanes() : {}) } : null,
      smokeDead: p.smokeDead, body: { shown: !!p.body?.visible, alpha: p.body ? +p.body.alpha.toFixed(3) : null, top: p.body?.parent === this.bodyTop, shadow: +(p.shadow ?? 0).toFixed(3) },
      glow: Object.fromEntries(p.parts.map((q) => [q.k, +q.pix.alpha.toFixed(3)])),
      rings: { tau: p.rings.tau, frames: p.rings.frames, shown: !!this.fxRings?.visible },
      look: { fire: { u: p.fire.u, frames: p.fire.frames, shown: !!this.lookFire?.visible }, dim: p.dim?.visible ? +p.dim.alpha.toFixed(3) : 0,
        dimAt: p.dim?.visible ? [+p.dim.position.x.toFixed(1), +p.dim.position.y.toFixed(1)] : null },
      outer: this.outer.some((o) => o.visible), flash: this.flash?.visible ? +this.flash.alpha.toFixed(3) : 0,
      shake: this.root ? [+this.root.position.x.toFixed(2), +this.root.position.y.toFixed(2)] : null,
    };
  }

  /** Phase 2's own textures and the smoke painter (his sprite shares HIS texture: never destroyed here). */
  #dropPhase2() {
    const p = this.p2;
    if (!p) return;
    if (p.drawnHook != null) { try { Hooks.off(DRAWN_HOOK, p.drawnHook); } catch { /* gone */ } p.drawnHook = null; }
    try { p.smoke?.drop(); } catch { /* gone */ }
    try { p.body?.parent?.removeChild(p.body); p.body?.destroy({ texture: false, baseTexture: false }); } catch { /* gone */ }
    for (const q of [p.rings?.color, p.rings?.light, p.fire?.color, p.fire?.light]) { try { q?.sp.parent?.removeChild(q.sp); q?.sp.destroy({ texture: true, baseTexture: true }); } catch { /* gone */ } }
    for (const q of p.parts) for (const s of [...q.halos.map((h) => h.s), q.pix]) { try { s.parent?.removeChild(s); s.destroy(); } catch { /* gone */ } }
    try { p.dim?.parent?.removeChild(p.dim); p.dim?.destroy(); } catch { /* gone */ }
    for (const tx of p.owned) { try { tx.destroy(true); } catch { /* gone */ } }
    p.owned.length = 0;
  }
}

/* ── Every client ──────────────────────────────────────────────────────── */

let _ticker = null, _tickerOwner = null;
function startTicker() {
  const tk = canvas?.app?.ticker ?? PIXI.Ticker.shared;
  if (_ticker && _tickerOwner === tk) return;
  if (_ticker) { try { _tickerOwner.remove(_ticker); } catch { /* gone */ } }
  _ticker = () => { for (const sh of [..._shows]) { try { sh.step(); } catch (e) { warn("nidhogg-return: step threw", e); sh.finish(); } } };
  _tickerOwner = tk;
  // just before the render, after the crystal host (its hold reads this frame's state), as the fall
  tk.add(_ticker, null, (PIXI.UPDATE_PRIORITY?.LOW ?? -25) + 2);
}

function stopTicker() {
  if (_ticker) { try { _tickerOwner?.remove(_ticker); } catch { /* gone */ } }
  _ticker = null; _tickerOwner = null;
}

/**
 * Play the return on THIS client. spec: { sceneId, dragonTokenId, crystalTokenId, plan }. Resolves when it is over
 * here (at once where nothing is drawn). opts.clock: a stepped clock for rigs.
 */
export function playNidhoggReturnLocal(spec, opts = {}) {
  try {
    if (!spec || !canvas?.ready || typeof PIXI === "undefined" || !shouldRender()) return Promise.resolve();
    if (spec.sceneId && canvas.scene?.id !== spec.sceneId) return Promise.resolve();
    // (WP7) the same return already playing here (the GM's answer to a late joiner reaches every client): that one
    const same = spec.id ? [..._shows].find((s) => s.specId === spec.id && !s.finished) : null;
    if (same) return same.done;
    // (WP7) a spec stamped with the GM's start: a client that starts late jumps to that second (null: it is over)
    //   (the GM's own show runs on the GM's clock, the one its rules wait on: opts.startAt from presentNidhoggReturn / rejoin)
    const startAt = opts.startAt ?? (opts.clock ? 0 : lateStartAt(spec.startedAt, serverNow(), planOf(spec.plan)));
    if (startAt == null || (!opts.clock && startAt >= planOf(spec.plan).end - LATE_MIN)) return Promise.resolve();
    const dragon = canvas.tokens.get(spec.dragonTokenId) ?? null;
    const show = new NidhoggReturnShow({ dragon, crystalTokenId: spec.crystalTokenId, plan: spec.plan, clock: opts.clock ?? null, startAt, specId: spec.id ?? null, startedAt: opts.clock ? null : spec.startedAt, opening: spec.opening ?? null });
    _shows.add(show);
    startTicker();
    return show.done;
  } catch (e) {
    warn("nidhogg-return: the show could not start", e);
    return Promise.resolve();
  }
}

/**
 * GM: start the return on every client and return its clock, or null when nobody is watching (the rules then run at
 * once). at(s) resolves at the return's second s on the GM's wall clock; done when it is over (and the GM's own show,
 * if it draws, has finished).
 */
export function presentNidhoggReturn(spec) {
  try { if (!shouldRender() && !hasOtherViewers()) return null; } catch { return null; }
  // (WP7) stamped with an id and the GM's start (server ms): a client that gets it late, or asks for it after joining /
  // reloading / redrawing its canvas, starts at the right second
  const P = planOf(spec?.plan), full = { ...spec, plan: wirePlan(P), id: foundry.utils.randomID(), startedAt: serverNow() };
  const t0 = performance.now(), end = P.end;
  const live = _live = { spec: full, t0, untilMs: t0 + end * 1000 };
  try { game.socket?.emit?.(`module.${MODULE_ID}`, { type: MSG, spec: full }); } catch (e) { warn("nidhogg-return: broadcast failed", e); }
  const local = playNidhoggReturnLocal(full, { startAt: 0 });
  const until = (s) => new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - performance.now())));
  const done = Promise.all([until(end), local]).then(() => { if (_live === live) _live = null; });
  return { at: (s) => until(s), done, plan: P };
}

/* ── Late joiners (WP7) ───────────────────────────────────────────────────
 * The broadcast reaches only the clients connected at that moment, and a client's show dies with its canvas. So the
 * GM keeps the return it is presenting (_live); a client whose canvas becomes ready (it joined, reloaded, changed
 * scene and back) asks for it, and the GM answers with the same spec to everyone (a client already playing it ignores
 * it by id); the spec's startedAt puts each one on the GM's second. The GM's own canvas redrawn mid-show replays its
 * local show the same way. Nothing is written to the world. */
let _live = null;   // GM: { spec, t0, untilMs (performance.now) }
const ASK = "FU_NIDHOGG_RETURN_ASK";
/** Server time (ms), the clock every client shares (Foundry syncs it); the local clock without a game. */
function serverNow() {
  try { const t = game?.time?.serverTime; if (Number.isFinite(t) && t > 0) return t; } catch { /* none */ }
  return Date.now();
}
const liveSpec = () => (_live && performance.now() < _live.untilMs ? _live.spec : null);
/** This client's canvas is ready: replay the GM's own live return, or ask the GM for one. */
function rejoin() {
  const sp = liveSpec();
  if (sp) { playNidhoggReturnLocal(sp, { startAt: (performance.now() - _live.t0) / 1000 }); return "replayed"; }
  try { game.socket?.emit?.(`module.${MODULE_ID}`, { type: ASK, user: game.user?.id ?? null }); } catch { /* offline */ }
  return "asked";
}

/* ── As a Boss Cycle transition (boss-rules/boss-cycle-styles.js) ─────────── */

/** Nidhogg's settings name it (bossCycle.transition.return). */
export const NIDHOGG_RETURN_TRANSITION = NAME;
registerBossCycleTransition(NAME, {
  present: (spec) => presentNidhoggReturn({ sceneId: spec.sceneId, dragonTokenId: spec.bossTokenId, crystalTokenId: spec.coreTokenId }),
  // while his battle is on the canvas: phase 2's still pieces made ahead (the build at the black was a ~180 ms frame)
  prepare: (spec) => prepareNidhoggReturn(spec),
  // the core is gone as the dark closes on its last light; he is back (full HP / MP, in play) at the roar
  beats: () => { const b = returnBeats(returnPlan()); return { hidden: b.hidden, reveal: b.reveal }; },
});

let _hooked = false;
export function initNidhoggReturn() {
  if (_hooked || typeof Hooks === "undefined") return;
  _hooked = true;
  preloadSfx(cueUrls(returnSfx(), [returnBed()])).catch(() => {});
  game.socket?.on?.(`module.${MODULE_ID}`, (m) => {
    if (m?.type === MSG) playNidhoggReturnLocal(m.spec);
    // (WP7) a late joiner asks: the GM presenting one answers with it (to everyone; the ones playing it ignore it)
    else if (m?.type === ASK && game.user?.isGM) {
      const sp = liveSpec();
      if (sp) { try { game.socket.emit(`module.${MODULE_ID}`, { type: MSG, spec: sp }); } catch { /* offline */ } }
    }
  });
  Hooks.on("canvasTearDown", () => { for (const sh of [..._shows]) sh.finish(); });
  // (WP7) a canvas ready mid-return (joined, reloaded, redrawn): jump in at the GM's second. canvasReady comes before
  // `ready` on a page load (this runs at ready), so the first one is asked for here.
  Hooks.on("canvasReady", () => { try { rejoin(); } catch (e) { warn("nidhogg-return: rejoin failed", e); } });
  if (canvas?.ready) { try { rejoin(); } catch { /* offline */ } }
  globalThis.__FU_NIDHOGG_RETURN__ = {
    /** Play it on THIS client only (no rules): { dragonTokenId, crystalTokenId, plan }. */
    play: (spec, opts) => playNidhoggReturnLocal({ sceneId: canvas.scene?.id, ...spec }, opts),
    /** Rigs: GM, present it to every client (no rules; the same broadcast the Boss Cycle sends). */
    present: (spec) => presentNidhoggReturn({ sceneId: canvas.scene?.id, ...spec }),
    /** Rigs: what a canvas-ready does (replay the GM's live return / ask the GM). */
    rejoin: () => rejoin(),
    live: () => liveSpec(),
    shows: () => [..._shows],
    status: () => [..._shows].map((s) => s.status()),
    /** Rigs: phase 2's still pieces made ahead for his token (prepareNidhoggReturn), the prepares running, the last one's cost. */
    still: (dragonTokenId) => ({ made: stillStatus(canvas?.tokens?.get?.(dragonTokenId)), jobs: _stillJobs.size, last: _lastStill }),
    stillCheck: (dragonTokenId) => stillCheck(canvas?.tokens?.get?.(dragonTokenId)),
    /** The clock's numbers (returnPlan at the defaults, or for { len, pause, doneAt }). */
    plan: (o) => planOf(o),
  };
}
