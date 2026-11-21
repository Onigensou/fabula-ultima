// timed-strike-cinematic.js — the Renzokuken cinematic, played on EVERY client
// from the trigger gauge's cues (timed-strike-gauge.js → Hooks "fuTimedStrikeGauge").
//
// A faithful port of the approved mockup (user, 2026-11-21: "port it faithfully"):
//   E:\Art(New Com)\DND\Fabula Ultima\Resource\Animation\Lionheart\lionheart-mockup.html v4
//   (sources: src\part-lionheart.js; FF8 study: reference\NOTES.md)
// Same beats, same numbers (the mockup's final slider values are CINE below), same
// assets from Forge, on the live battle board:
//
//   open      intro: the field dims UNDER the two actors and every other battler fades,
//             the camera pushes onto the wielder, a gold pixelfx light pillar with motes
//             (Limit Break.mp3), then the dash (DashA.wav) with speed lines, afterimages
//             and dust, the camera riding along into the two-shot. TSG_TIMING.introMs later
//             the gauge slides in (the GM holds that beat, never waiting on a client).
//   strike i  one of five cuts (lean, slide, afterimage, MV slash clip + a tapered slash
//             sheet at its own angle, sparks); the camera steps in, tilts the other way and
//             punches. A TRIGGER fires the gun through the blade: muzzle flash + gunshot,
//             fire burst, red bloom, white speed rays, embers, one white frame, a chromatic
//             split, shards, a hit-stop. Strikes queue behind the input (the mockup's two lanes).
//   finisher  Lion Heart (6/6 only): the field sinks darker, the camera leans onto the
//             target, magnum, white, an anime impact frame, the special slash, a big punch +
//             split, rays, a blue bloom, sparks and sparkle dust.
//   done      result cue, then the camera returns home, the dim lifts, the battlers fade
//             back and the wielder hops home.
//
// Damage numbers, the HP bar and the hurt flinch are the game's own (the GM applies each
// strike as it is judged); this file draws nothing that carries text.
//
// Live board (reference_battle_stage_3d_for_animations): oni.timeline({ live: true }) —
// only the tokens a beat touches are hidden and painted (the wielder while it moves, the
// faded bystanders); the target stays the real token, so its real hurt reaction shows.
// The camera is the real canvas camera: the camera authority is suspended for the run
// (the 3D camera mode eases to neutral as for any cinematic; the parallax keeps running
// off the live view), the mockup's roll is a CSS rotation of the board + overlay with a
// matching scale so no void shows. Everything is restored on every exit: the restore
// beat, CLOSE without DONE, a watchdog, a scene change, a newer run.

import { log, warn } from "./logger.js";
import { buildOni } from "../anim-studio/oni-helpers.js";
import { playSfx, preloadSfx } from "./director-sfx.js";
import { stageLocal } from "../action-animation/animation-stage.js";
import { MV_CLIPS, clipUrl } from "./action-anim-rules.js";
import { suspendCamera } from "./camera-authority.js";
import { restViewFor, resolveIntent, pivotShift, viewportOf } from "./director-camera.js";
import { TSG_TIMING } from "./timed-strike-gauge.js";

const TAG = "timed-strike-cinematic";
const HOOK = "fuTimedStrikeGauge";
const OUT_HOOK = "fuTimedStrikeCinematic";   // test/observer cues: intro, strike, impact, restore, end
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const SND = FORGE + "Sound/", ANIM = FORGE + "Animation/";

// The mockup's final slider values (Renzokuken tune, v2-v4), used as constants.
export const CINE = Object.freeze({
  zoom: 1.7,        // camera zoom on the two-shot (× rest framing)
  zstep: 4,         // extra push per slash (%)
  punch: 5,         // per-hit zoom punch (%)
  tilt: 2.5,        // camera roll per slash (deg)
  dim: 60,          // battlefield dim under the two actors (%)
  fade: 0,          // other battlers fade to (% opacity)
  fadeMs: 650,      // fade out / back in (ms)
  camBack: 1100,    // camera return after the last hit (ms)
  parts: 100,       // particle density (%)
  wframe: 55,       // TRIGGER white frame (%)
  chroma: 6,        // TRIGGER chromatic split (px)
  hitstop: 60,      // TRIGGER hit-stop (ms)
  findim: 85,       // finisher dim (%)
  open: 0,          // camera into the sequence: 0 = smooth push onto the wielder (approved)
  pillar: 0,        // power-up light before the dash: 0 = on (pixelfx gold pillar)
});

// pixelfx pxfx_lh_ice_pillar (the finisher's light, the gold pillar in the ice palette) is
// built locally (pixelfx\foundry\out\pxfx_lh_ice_pillar) but NOT on Forge yet (checked
// 2026-11-21: 404). Upload its three layers to the path below and flip this on; until then
// the finisher plays without the pillar (no hand-drawn stand-in, by the house rule).
const ICE_PILLAR_ON_FORGE = false;

// ── assets (all Forge, all the mockup's) ────────────────────────────────────
const mv = (key) => ({ url: clipUrl(key), w: MV_CLIPS[key].w, h: MV_CLIPS[key].h, ax: MV_CLIPS[key].ax, ay: MV_CLIPS[key].ay, dur: MV_CLIPS[key].dur });
const GG = ANIM + "Guilty%20Gear%20Strive/webm/";
const PXN = ANIM + "pixelfx/nox/pxfx_nox_luxpillar_";
const PXI = ANIM + "pixelfx/lionheart/pxfx_lh_ice_pillar_";
const PILLAR = { w: 384, h: 464, ax: 0.5, ay: 0.8793, dur: 3533 };
export const CINE_CLIPS = Object.freeze({
  "006_slash_physical": mv("006_slash_physical"),
  "007_slash_effect": mv("007_slash_effect"),
  "002_hit_effect": mv("002_hit_effect"),
  "023_slash_special_1": mv("023_slash_special_1"),
  gg_burst_anim02: { url: GG + "burst_anim02.webm", w: 682, h: 1024, ax: 0.5, ay: 0.5, dur: 300 },
  gg_spark_anim01: { url: GG + "spark_anim01.webm", w: 340, h: 256, ax: 0.5, ay: 0.5, dur: 300 },
  gg_fireanim02: { url: GG + "fireanim02.webm", w: 512, h: 512, ax: 0.5, ay: 0.5, dur: 3200 },
  px_lux_back: { url: PXN + "back.webm", ...PILLAR }, px_lux_front: { url: PXN + "front.webm", ...PILLAR }, px_lux_light: { url: PXN + "light.webm", ...PILLAR },
  ...(ICE_PILLAR_ON_FORGE ? { px_ice_back: { url: PXI + "back.webm", ...PILLAR }, px_ice_front: { url: PXI + "front.webm", ...PILLAR }, px_ice_light: { url: PXI + "light.webm", ...PILLAR } } : {}),
});
// [url, the mockup's volume]; the mockup plays sfx(key, vol) at vol × 0.75
export const CINE_SFX = Object.freeze({
  limit: SND + "Limit%20Break.mp3", dash: SND + "DashA.wav", sword2: SND + "Soundboard/Sword2.ogg", sword4: SND + "Soundboard/Sword4.ogg",
  gunshot: SND + "GunshotA.ogg", slashL: SND + "Soundboard/SE_BTL_HitSlashL.ogg", slash1: SND + "Soundboard/Slash1.ogg",
  magnum: SND + "Gun_Magnum.ogg", shing: SND + "Metal_Shing.mp3", crit: SND + "Soundboard/SE_BTL_HitCritical.ogg",
  jump1: SND + "Soundboard/Jump1.ogg", flash2: SND + "Soundboard/Flash2.ogg", confirm: SND + "Cursor_Confirm.mp3",
});
const sfx = (key, vol = 0.55) => { try { const u = CINE_SFX[key]; if (u) playSfx(u, Math.min(1, vol * 0.75)); } catch (_) {} };

// ── maths (the mockup's) ─────────────────────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const EASE = {
  lin: (t) => t, quad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2), out: (t) => 1 - (1 - t) * (1 - t), in: (t) => t * t,
  sine: (t) => -(Math.cos(Math.PI * t) - 1) / 2, outCubic: (t) => 1 - Math.pow(1 - t, 3),
};
const FIRE = "255,140,50", STEEL = "170,210,255", GOLD = "255,214,120";
// five different cuts (lean deg, clip rot deg, slide px, slash-sheet angle deg); a 6th strike reuses the first
const CUTS = [{ lean: 16, rot: 0, dx: 0, sw: -24 }, { lean: -12, rot: 180, dx: -14, sw: 158 }, { lean: 22, rot: -35, dx: 10, sw: -62 }, { lean: -8, rot: 35, dx: -6, sw: 30 }, { lean: 18, rot: 90, dx: 8, sw: 96 }];
const ABORT = new Error("timed-strike-cinematic aborted");
const FOLLOW_HOLD = "timed-strike-cinematic";
// Black-background clips (pixelfx light layers, Guilty Gear) drawn additive onto the timeline's
// transparent overlay would leave opaque black boxes: a luma-to-alpha SVG filter turns black
// into transparent (the same filter the Nox / legacy shot kits use, id "oni-luma-alpha").
const LUMA_ID = "oni-luma-alpha";
function lumaFilter() {
  try {
    if (!document.getElementById(LUMA_ID)) {
      const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
      svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.style.position = "absolute"; svg.style.pointerEvents = "none";
      const f = document.createElementNS(ns, "filter"); f.setAttribute("id", LUMA_ID); f.setAttribute("color-interpolation-filters", "sRGB");
      const cm = document.createElementNS(ns, "feColorMatrix"); cm.setAttribute("type", "matrix"); cm.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  1 1 1 0 0");
      f.appendChild(cm); svg.appendChild(f); document.body.appendChild(svg);
    }
  } catch (_) {}
  return `url(#${LUMA_ID})`;
}
const glow = (c, x, y, r, rgb, a) => { if (!(r > 0)) return; const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`); c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); };
// the approved tapered-blade slash (reference_slash_vfx_tapered_blade): straight polygon, head races, tail follows
function bladePoly(c, ax, ay, bx, by, w) {
  const L = Math.hypot(bx - ax, by - ay); if (L < 1 || w <= 0) return; const ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy, ny = ux, N = 24, top = [], bot = [];
  for (let i = 0; i <= N; i++) { const u = i / N; let h = w / 2 * Math.pow(Math.sin(Math.PI * u), 0.7); if (u > 0.6) h *= 1 - (u - 0.6) * 0.5; const px = ax + (bx - ax) * u, py = ay + (by - ay) * u; top.push([px + nx * h, py + ny * h]); bot.push([px - nx * h, py - ny * h]); }
  c.beginPath(); c.moveTo(top[0][0], top[0][1]); for (const p of top) c.lineTo(p[0], p[1]); for (let i = bot.length - 1; i >= 0; i--) c.lineTo(bot[i][0], bot[i][1]); c.closePath(); c.fill();
}

// the chromatic split (SVG filter: R shifted one way, B the other), shared by every run
const CA_ID = "fuLhCA";
function ensureChromaFilter() {
  if (document.getElementById(CA_ID)) return;
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("width", "0"); s.setAttribute("height", "0"); s.style.position = "absolute"; s.setAttribute("aria-hidden", "true");
  s.innerHTML = `<filter id="${CA_ID}" color-interpolation-filters="sRGB"><feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/><feOffset id="${CA_ID}r" in="r" dx="0" result="r2"/>
    <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="g"/><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="b"/>
    <feOffset id="${CA_ID}b" in="b" dx="0" result="b2"/><feBlend in="r2" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b2" mode="screen"/></filter>`;
  document.body.appendChild(s);
}

const runs = new Map();   // requestId → Cine

class Cine {
  constructor(requestId, spec) {
    this.id = requestId;
    this.spec = spec ?? {};
    this.alive = true;
    this.ended = false;
    this.queue = [];           // judged strikes waiting for their animation
    this.wake = null;
    this.finisherPending = false;
    this.finisherPlayed = false;
    this.doneReq = null;
    this.restoring = false;
    this.P = [];               // particles (world px)
    this.AF = [];              // afterimages
    this.shakes = [];
    this.SL = null;            // speed lines
    this.impact = null;
    this.A = { dx: 0, dy: 0, rot: 0, lift: 0, bob: 0 };
    this.O = { alpha: 1 };
    this.D = { dim: 0 };
    this.FL = { a: 0, c: "#fff" };
    this.CA = null;            // { px, punch } while a chromatic split plays
    this.CD = { on: false, x: 0, y: 0, z: 1, r: 0, tgt: null, follow: null, punch: 0, lag: 220 };
    this.camOwned = false;
    this.tNow = 0;
    this.lastNow = performance.now();
    this.fx = (o) => { try { Hooks.callAll(OUT_HOOK, { requestId: this.id, ...o }); } catch (_) {} };
  }

  // ── run control (the mockup's RUN / ABORT) ──
  live() { if (!this.alive) throw ABORT; }
  wait(ms) { return new Promise((res, rej) => setTimeout(() => (this.alive ? res() : rej(ABORT)), Math.max(0, ms))); }
  tween(ms, ease, fn) {
    return new Promise((res, rej) => {
      const t0 = performance.now(), d = Math.max(1, ms);
      const step = (now) => { if (!this.alive) return rej(ABORT); const t = Math.min(1, (now - t0) / d); try { fn(ease(t)); } catch (_) {} if (t < 1) requestAnimationFrame(step); else res(); };
      requestAnimationFrame(step);
    });
  }
  soft(p) { return p.catch((e) => { if (e !== ABORT) warn(`${TAG}: beat threw`, e); }); }

  // ── start: tokens, overlay, camera ──
  async start() {
    const sp = this.spec;
    if (!globalThis.canvas?.ready || (sp.sceneId && canvas.scene?.id !== sp.sceneId)) return this.inert("no canvas / other scene");
    const caster = canvas.tokens.get(sp.casterTokenId);
    const target = (sp.targetTokenIds ?? []).map((id) => canvas.tokens.get(id)).find((t) => t?.mesh);
    if (!caster?.mesh || !target) return this.inert("caster / target not on this canvas");
    this.caster = caster; this.target = target;
    ensureChromaFilter();
    // assets: warm what the beats use (the intro hides the first decode)
    stageLocal(Object.values(CINE_CLIPS).map((c) => c.url)).catch(() => {});
    preloadSfx(Object.values(CINE_SFX)).catch(() => {});

    // the camera is ours for the run (the 3D camera mode eases to neutral meanwhile)
    this.resumeCam = suspendCamera();
    try { globalThis.__ONI_MOVEMENT_CONTROL_CAMERA_RUNTIME__?.holdCamera?.(FOLLOW_HOLD); this.followHeld = true; } catch (_) {}
    this.camOwned = true;
    try {
      const S3 = globalThis.__ONI_BATTLE_STAGE_3D__;
      for (let i = 0; i < 12 && S3?.cameraLive?.(); i++) await new Promise((r) => setTimeout(r, 50));
    } catch (_) {}
    if (!this.alive) return;

    const others = canvas.tokens.placeables.filter((t) => t !== caster && t !== target && !(sp.targetTokenIds ?? []).includes(t.id) && t.visible && t.mesh && !t.document.hidden && t.mesh.alpha > 0.05);
    // hurt: "" = no hurt-loop copy (the target's real token plays the game's own hurt reaction)
    const tokens = { a: { token: caster, hurt: "" }, t: { token: target, hurt: "" } };
    others.forEach((t, i) => { tokens["o" + i] = { token: t, hurt: "" }; });
    this.otherKeys = others.map((_, i) => "o" + i);
    this.oni = buildOni({ casterToken: caster, targetTokens: [target], params: {} },
      { canvas, PIXI, loadTexture: globalThis.loadTexture ?? foundry.canvas?.loadTexture, fromUuid, wait: (ms) => new Promise((r) => setTimeout(r, ms)), foundry });
    this.tl = this.oni.timeline({ live: true, depthRef: "a", tokens, clips: CINE_CLIPS });
    await this.tl.load();
    if (!this.alive) { this.teardown(); return; }
    const tl = this.tl;
    this.TA = tl.TOK.a; this.TT = tl.TOK.t;
    this.homeA = tl.feet(this.TA);
    this.U = (tl.STAGE?.w || 1682) / 1682;   // mockup px → world px (1 on a 1682-wide stage)
    this.face = Math.sign(this.TT.x - this.TA.x) || -1;   // the wielder faces the target
    this.fl = -this.face;                                   // the mockup's baseFlip (party = 1)
    this.view0 = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
    this.rest = restViewFor(canvas.scene);
    const ins = viewportOf()?.insets ?? null, off = pivotShift(ins, this.view0.scale);
    Object.assign(this.CD, { x: this.view0.x - off.x, y: this.view0.y - off.y, z: this.view0.scale / (this.rest.scale || 1), r: 0 });
    this.CD.tgt = { x: this.CD.x, y: this.CD.y, z: this.CD.z, r: 0 };

    this.T = [];
    const m = tl.mk(this.T); this.m = m;
    m.hold(0, 1e9, (t, S) => this.frame(t, S));
    this.runP = tl.run(this.T, { total: () => (this.ended ? 0 : 1e9), lead: 0 }).catch((e) => warn(`${TAG}: timeline threw`, e));
    this.runP.then(() => this.teardown());
    this.fx({ phase: "start", info: { others: others.length } });
    log(`${TAG}: ${caster.name} → ${target.name} (${others.length} faded)`);
    this.main().catch((e) => { if (e !== ABORT) warn(`${TAG}: main threw`, e); this.abort("main threw"); });
  }

  inert(why) { this.alive = false; this.ended = true; this.inertWhy = why; log(`${TAG}: inert (${why})`); runs.delete(this.id); }

  // ── the run: intro → strikes (queued) → finisher → result + restore ──
  async main() {
    this.introP = this.intro();
    await this.introP;
    this.fx({ phase: "intro-end" });
    let i = 0;
    for (;;) {
      while (!this.queue.length && !this.finisherPending && !this.doneReq) { await new Promise((r) => { this.wake = r; }); this.live(); }
      if (this.queue.length) { const g = this.queue.shift(); await this.strike(g.i ?? i, g.hit); i = (g.i ?? i) + 1; await this.leanTo(0, this.queue.length ? 50 : 90); continue; }
      if (this.finisherPending) { this.finisherPending = false; this.finisherPlayed = true; await this.lionHeart(); continue; }
      break;
    }
    await this.result();
    this.end();
  }
  kick() { const w = this.wake; this.wake = null; if (w) w(); }
  onStrike(i, hit) { if (this.restoring) return; this.queue.push({ i, hit }); this.kick(); }
  onFinisher() { if (this.finisherPending || this.finisherPlayed || this.restoring) return; this.finisherPending = true; this.kick(); }
  onDone(d) { this.doneReq = d ?? {}; this.kick(); }
  // CLOSE without DONE (a missed message): restore now
  onClose() { if (!this.doneReq) { this.doneReq = {}; this.queue.length = 0; } this.kick(); }

  // ── per-frame: camera, particles, state → the timeline ──
  frame(t, S) {
    const now = performance.now(), dt = Math.min(50, now - this.lastNow); this.lastNow = now; this.tNow = t;
    if (this.camOwned) this.stepCamera(dt);
    // particles
    for (let i = this.P.length - 1; i >= 0; i--) {
      const p = this.P[i]; p.t += dt;
      if (p.t >= p.life || p.dead) { this.P.splice(i, 1); continue; }
      if (p.update) p.update(p, dt); else { p.vy += p.g * dt; p.vx *= Math.pow(p.drag, dt / 16); p.vy *= Math.pow(p.drag, dt / 16); p.x += p.vx * dt; p.y += p.vy * dt; }
    }
    for (let i = this.AF.length - 1; i >= 0; i--) if (now - this.AF[i].t0 >= this.AF[i].ms) this.AF.splice(i, 1);
    let shake = 0; for (let i = this.shakes.length - 1; i >= 0; i--) { const s = this.shakes[i], u = (now - s.t0) / s.ms; if (u >= 1) { this.shakes.splice(i, 1); continue; } shake = Math.max(shake, s.px * (1 - u)); }
    // board state
    S.dim = this.D.dim; S.dimRGB = "7,4,12";
    const A = this.A, ta = S.tok.a;
    if (ta) { ta.dx = A.dx; ta.dy = A.dy; ta.rot = A.rot * Math.PI / 180; ta.air = A.lift + A.bob; }
    for (const k of this.otherKeys ?? []) if (S.tok[k]) S.tok[k].alpha = this.O.alpha;
    S.shake = shake;
    if (this.FL.a > 0) S.flash = { a: this.FL.a, c: this.FL.c };
    if (this.AF.length) S.world.push({ z: 4, draw: (g) => this.drawAfterimages(g, now) });
    if (this.P.length) S.world.push({ z: 50, draw: (g) => this.drawParticles(g) });
    if (this.SL) S.screen.push({ draw: (g) => this.drawSpeedLines(g, dt) });
    if (this.impact) S.over.push({ draw: (g) => this.drawImpact(g) });
    this.applyChroma();
  }

  // ── geometry (drawn world px, like the mockup's field px) ──
  ratioA() { const f = this.homeA; return this.tl.depthRatio(f, { x: f.x + this.A.dx, y: f.y + this.A.dy }); }
  OX() { return this.TA.x + this.A.dx; }
  OY() { return this.homeA.y + this.A.dy; }
  hgtA() { return this.TA.h * this.ratioA(); }
  widA() { return this.TA.w * this.ratioA(); }
  sA() { return this.tl.depthS(this.OX(), this.OY()) || 1; }
  feetA() { return { x: this.OX(), y: this.OY() }; }
  centerA() { return { x: this.OX(), y: this.OY() - (this.A.lift + this.A.bob) - this.hgtA() * 0.5 }; }
  hand() { return { x: this.OX() + this.face * this.widA() * 0.34, y: this.OY() - (this.A.lift + this.A.bob) - this.hgtA() * 0.52 }; }
  feetT() { return this.tl.feet(this.TT); }
  hgtT() { return this.TT.h; }
  sT() { const f = this.feetT(); return this.tl.depthS(f.x, f.y) || 1; }
  centerT() { const f = this.feetT(); return { x: f.x, y: f.y - this.TT.h * 0.5 }; }
  // a point in front of the target, on the wielder's side
  front(gap = 70) { const f = this.feetT(); return { x: f.x - this.face * gap * this.U * this.sT(), y: f.y }; }
  twoShot() { const pa = this.centerA(), pt = this.centerT(); return { x: (pa.x + pt.x) / 2, y: (pa.y + pt.y) / 2 - 8 * this.U }; }

  // ── camera: the mockup's follow camera (exponential ease toward a target / follow point; punch = a decaying zoom impulse) ──
  camGo(p, lag = this.CD.lag) { this.CD.tgt = { ...this.CD.tgt, ...p }; this.CD.lag = lag; this.CD.on = true; }
  stepCamera(dt) {
    const CD = this.CD;
    if (CD.on) {
      const g = CD.follow ? { ...CD.tgt, ...CD.follow() } : CD.tgt, k = 1 - Math.exp(-dt / CD.lag);
      CD.x = lerp(CD.x, g.x, k); CD.y = lerp(CD.y, g.y, k); CD.r = lerp(CD.r, g.r, k); CD.z = Math.exp(lerp(Math.log(CD.z), Math.log(g.z), k));
      CD.punch *= Math.exp(-dt / 120);
    }
    if (this.homing) return;   // camHome drives the view itself
    this.writeCamera({ x: CD.x, y: CD.y, z: CD.z * (1 + CD.punch), r: CD.r });
  }
  // roll = CSS rotation of the board and the overlay, with the scale that keeps the view covered;
  // the PIXI zoom is divided by that scale so the framing is the mockup's
  rollScale(rDeg) { const a = Math.abs(rDeg) * Math.PI / 180; if (a < 1e-4) return 1; const W = canvas.app.renderer.screen.width, H = canvas.app.renderer.screen.height; return Math.cos(a) + Math.max(W / H, H / W) * Math.sin(a); }
  writeCamera({ x, y, z, r }) {
    if (!canvas?.ready) return;
    const k = this.rollScale(r);
    let v = null;
    try { v = resolveIntent({ point: { x, y }, zoom: z / k }, canvas.scene); } catch (_) { v = null; }
    if (v) this.applyView(v);
    this.applyRoll(r, k);
  }
  applyView(v) {
    const st = canvas.stage;
    st.pivot.set(v.x, v.y); st.scale.set(v.scale, v.scale);
    try { canvas.updateBlur?.(); } catch (_) {}
    try { canvas.hud?.align?.(); } catch (_) {}
    try { canvas.scene._viewPosition = { x: v.x, y: v.y, scale: v.scale }; } catch (_) {}
  }
  rollEls() { return [canvas?.app?.view, document.querySelector(".oni-timeline-overlay")].filter(Boolean); }
  applyRoll(rDeg, k) {
    const on = Math.abs(rDeg) > 1e-3;
    for (const el of this.rollEls()) { el.style.rotate = on ? `${rDeg.toFixed(3)}deg` : ""; el.style.scale = on ? k.toFixed(4) : ""; }
  }
  async camHome(ms) {
    const CD = this.CD; CD.follow = null; CD.punch = 0;
    const st = canvas.stage, from = { x: st.pivot.x, y: st.pivot.y, s: st.scale.x, r: CD.r };
    const to = restViewFor(canvas.scene);
    this.homing = true;
    await this.tween(ms, EASE.sine, (t) => {
      const r = lerp(from.r, 0, t);
      this.applyView({ x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t), scale: Math.exp(lerp(Math.log(from.s), Math.log(to.scale), t)) });
      this.applyRoll(r, this.rollScale(r)); CD.r = r;
    });
    this.applyView(to); this.applyRoll(0, 1);
  }

  // ── screen effects ──
  flash(color = "#fff", peak = 1, inMs = 40, outMs = 160) { this.FL.c = color; return this.tween(inMs, EASE.lin, (t) => { this.FL.a = peak * t; }).then(() => this.tween(outMs, EASE.out, (t) => { this.FL.a = peak * (1 - t); })); }
  whiteTo(o, ms, ease = EASE.sine) { this.FL.c = "#fff"; const s = this.FL.a; return this.tween(ms, ease, (t) => { this.FL.a = lerp(s, o, t); }); }
  fdim(o, ms = 500) { const s = this.D.dim; return this.tween(ms, EASE.sine, (t) => { this.D.dim = lerp(s, o, t); }); }
  shake(px = 10, ms = 320) { this.shakes.push({ px: px * this.U, ms, t0: performance.now() }); }
  isolate(on, msMul = 1) {
    const ms = CINE.fadeMs * msMul, to = on ? CINE.fade / 100 : 1, a0 = this.O.alpha;
    return Promise.all([this.tween(ms, EASE.sine, (t) => { this.O.alpha = lerp(a0, to, t); }), this.fdim(on ? CINE.dim / 100 : 0, ms)]);
  }
  chroma(px, ms = 180, punch = 1.25) {
    if (px <= 0) return Promise.resolve();
    const C = { px: 0, punch: 1 }; this.CA = C;
    return this.tween(ms, EASE.out, (t) => { const k = 1 - t; C.px = px * k; C.punch = 1 + (punch - 1) * k; }).finally(() => { if (this.CA === C) this.CA = null; this.applyChroma(true); });
  }
  applyChroma(clear = false) {
    const C = clear ? null : this.CA; const els = this.rollEls();
    if (!C || C.px <= 0.01) { if (this._chromaOn) { for (const el of els) el.style.filter = ""; this._chromaOn = false; } return; }
    const r = document.getElementById(CA_ID + "r"), b = document.getElementById(CA_ID + "b");
    r?.setAttribute("dx", C.px.toFixed(2)); b?.setAttribute("dx", (-C.px).toFixed(2));
    const f = `url(#${CA_ID}) contrast(${C.punch.toFixed(3)}) saturate(${(1 + (C.punch - 1) * 1.6).toFixed(3)})`;
    for (const el of els) el.style.filter = f; this._chromaOn = true;
  }
  speedLines(on, { angle = 0, color = "255,255,255", alpha = 0.5, n = 26 } = {}) {
    if (!on) { this.SL = null; return; }
    this.SL = { angle, color, alpha, lines: Array.from({ length: n }, () => ({ u: Math.random(), off: rnd(-1, 1), len: rnd(0.15, 0.45), sp: rnd(0.0015, 0.003), w: rnd(1, 3.2) })) };
  }
  drawSpeedLines(g, dt) {
    const s = this.SL; if (!s) return; const sc = g.H / 788, W = g.W, H = g.H;
    g.save(); g.globalCompositeOperation = "lighter";
    const ca = Math.cos(s.angle), sa = Math.sin(s.angle), nx = -sa, ny = ca;
    for (const l of s.lines) {
      l.u += l.sp * dt; if (l.u > 1.3) { l.u = -0.3; l.off = rnd(-1, 1); }
      g.strokeStyle = `rgba(${s.color},${s.alpha * (0.4 + l.w / 4)})`; g.lineWidth = l.w * sc;
      const along = (l.u * 2 - 1) * 1300 * sc, perp = l.off * 900 * sc, x0 = W / 2 + ca * along + nx * perp, y0 = H / 2 + sa * along + ny * perp;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + ca * l.len * 900 * sc, y0 + sa * l.len * 900 * sc); g.stroke();
    }
    g.restore();
  }
  // an anime impact frame: black with the targets in white and a burst of lines, then white with them in black
  async impactFrame(keys, ms = 70) {
    const sc = canvas.stage.scale.x;
    const pts = keys.map((k) => this.screenBody(k, sc)).filter(Boolean);
    if (!pts.length) return;
    const cen = { x: pts.reduce((s, p) => s + p.cx, 0) / pts.length, y: pts.reduce((s, p) => s + p.cy, 0) / pts.length };
    const rays = (n) => Array.from({ length: n }, () => [rnd(0, Math.PI * 2), rnd(0.006, 0.03), rnd(90, 220)]);
    this.impact = { bg: "#000", fg: "#fff", sil: "#fff", pts, cen, rays: rays(46) };
    await this.wait(ms);
    this.impact = { bg: "#fff", fg: "#000", sil: "#000", pts, cen, rays: rays(46) };
    await this.wait(ms);
    this.impact = null;
  }
  screenBody(k, sc) {
    const T = this.tl.TOK[k]; if (!T) return null;
    const isA = k === "a", r = isA ? this.ratioA() : 1;
    const fx = isA ? this.OX() : T.x, fy = (isA ? this.OY() - (this.A.lift + this.A.bob) : this.tl.feet(T).y);
    const p = this.tl.toScreen(fx, fy), h = T.h * r * sc, w = T.w * r * sc;
    return { k, x: p.x, y: p.y, w, h, foot: T.foot, flip: T.flip, rot: isA ? this.A.rot * Math.PI / 180 : 0, cx: p.x, cy: p.y - h * 0.5 };
  }
  drawImpact(g) {
    const I = this.impact; if (!I) return; const W = g.W, H = g.H, s = H / 788;
    g.save(); g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    g.fillStyle = I.bg; g.fillRect(-20, -20, W + 40, H + 40);
    g.fillStyle = I.fg;
    for (const [a, w, r0] of I.rays) { g.beginPath(); g.moveTo(I.cen.x + Math.cos(a) * r0 * s, I.cen.y + Math.sin(a) * r0 * s); g.lineTo(I.cen.x + Math.cos(a - w) * 1900 * s, I.cen.y + Math.sin(a - w) * 1900 * s); g.lineTo(I.cen.x + Math.cos(a + w) * 1900 * s, I.cen.y + Math.sin(a + w) * 1900 * s); g.fill(); }
    for (const p of I.pts) { const c = this.tl.tinted(p.k, I.sil); if (!c) continue; g.save(); g.translate(p.x, p.y); if (p.rot) g.rotate(p.rot); g.scale(p.flip, 1); g.drawImage(c, -p.w / 2, -p.h * p.foot, p.w, p.h); g.restore(); }
    g.restore();
  }

  // ── particles (the mockup's addP, world px; default composite "lighter") ──
  addP(p) { this.P.push(Object.assign({ t: 0, life: 1000, vx: 0, vy: 0, g: 0, drag: 1 }, p)); }
  drawParticles(g) { for (const p of this.P) { g.save(); g.globalCompositeOperation = p.comp || "lighter"; try { p.draw(g, p, p.t / p.life); } catch (_) {} g.restore(); } }
  N(n) { return Math.max(0, Math.round(n * CINE.parts / 100)); }
  sparks(pt, n, rgb = GOLD, sp = 0.9) {
    for (let i = 0; i < n; i++) { const an = rnd(0, Math.PI * 2), v = rnd(0.25, sp) * this.U;
      this.addP({ x: pt.x, y: pt.y, vx: Math.cos(an) * v, vy: Math.sin(an) * v - 0.12 * this.U, g: 0.0016 * this.U, drag: 0.955, life: rnd(260, 520), w: rnd(1.2, 2.6) * this.U,
        draw: (c, p, t) => { c.strokeStyle = `rgba(${t < 0.3 ? "255,255,240" : rgb},${1 - t})`; c.lineWidth = p.w; c.beginPath(); c.moveTo(p.x - p.vx * 26, p.y - p.vy * 26); c.lineTo(p.x, p.y); c.stroke(); } }); }
  }
  slashSheet(pt, ang, { L = 200, w = 26, rgb = STEEL, ms = 300, core = 0.3 } = {}) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    this.addP({ x: pt.x, y: pt.y, life: ms, draw: (c, p, t) => {
      const hu = EASE.outCubic(Math.min(1, t / 0.22)), tu = t < 0.18 ? 0 : Math.pow((t - 0.18) / 0.82, 2);
      const h = -L + 2 * L * hu, tl = -L + 2 * L * tu; if (h - tl < 2) return; const ww = w * (1 - 0.5 * t), a = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
      const P = (u) => [p.x + ca * u, p.y + sa * u]; const [hx, hy] = P(h), [tx, ty] = P(tl);
      c.fillStyle = `rgba(${rgb},${0.22 * a})`; bladePoly(c, hx, hy, tx, ty, ww * 2.4);
      c.fillStyle = `rgba(${rgb},${0.85 * a})`; bladePoly(c, hx, hy, tx, ty, ww);
      c.fillStyle = `rgba(255,255,255,${0.95 * a})`; bladePoly(c, hx, hy, tx, ty, ww * core);
    } });
  }
  impactRays(pt, n, r0 = 30, r1 = 320, ms = 240, rgb = "255,255,255") {
    const rays = Array.from({ length: n }, () => [rnd(0, Math.PI * 2), rnd(0.01, 0.035), rnd(0.6, 1)]);
    this.addP({ x: pt.x, y: pt.y, life: ms, draw: (c, p, t) => { const a = 1 - t, R0 = r0 + (r1 - r0) * 0.25 * EASE.out(t), R1 = r1 * (0.6 + 0.4 * EASE.outCubic(t));
      c.fillStyle = `rgba(${rgb},${a * 0.85})`; for (const [an, w, k] of rays) { c.beginPath(); c.moveTo(p.x + Math.cos(an) * R0, p.y + Math.sin(an) * R0);
        c.lineTo(p.x + Math.cos(an - w) * R1 * k, p.y + Math.sin(an - w) * R1 * k); c.lineTo(p.x + Math.cos(an + w) * R1 * k, p.y + Math.sin(an + w) * R1 * k); c.fill(); } } });
  }
  bloom(pt, r, rgb = "255,70,30", ms = 380) { this.addP({ x: pt.x, y: pt.y, life: ms, draw: (c, p, t) => glow(c, p.x, p.y, r * (0.6 + 0.6 * EASE.outCubic(t)), rgb, 0.75 * (1 - t)) }); }
  ember(x, y, rgb = "255,140,60", o = {}) { this.addP({ x, y, vx: rnd(-0.03, 0.03), vy: rnd(-0.12, -0.05), life: rnd(1400, 2600), r: rnd(2, 5), ...o,
    draw: (c, p, t) => { const a = Math.sin(t * Math.PI); glow(c, p.x + Math.sin(p.t / 300) * 6, p.y, p.r * 3, rgb, a * 0.9); } }); }
  dust(x, y, rgb, o = {}) { this.addP({ x, y, vx: rnd(-0.02, 0.02), vy: rnd(-0.02, 0.02), life: rnd(1800, 3400), r: rnd(1, 2.6), ...o,
    draw: (c, p, t) => { const a = Math.sin(t * Math.PI) * (0.5 + 0.5 * Math.sin(p.t / 120 + p.x)); c.fillStyle = `rgba(${rgb},${a})`; c.beginPath(); c.arc(p.x, p.y, p.r, 0, 7); c.fill(); glow(c, p.x, p.y, p.r * 4, rgb, a * 0.35); } }); }
  shards(pt, rgb = "220,200,255", n = 14, spread = 0.5) {
    for (let i = 0; i < n; i++) { const an = rnd(0, Math.PI * 2), sp = rnd(0.15, spread);
      this.addP({ x: pt.x, y: pt.y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 0.2, g: 0.0012, drag: 0.985, life: rnd(600, 1000), rot: rnd(0, 6), vr: rnd(-0.02, 0.02), s: rnd(5, 11) * this.U,
        draw: (c, p, t) => { p.rot += p.vr * 16; c.translate(p.x, p.y); c.rotate(p.rot); c.globalAlpha = 1 - t; c.fillStyle = `rgba(${rgb},1)`; c.beginPath(); c.moveTo(0, -p.s); c.lineTo(p.s * 0.6, 0); c.lineTo(0, p.s * 0.9); c.lineTo(-p.s * 0.5, 0); c.fill(); } }); }
  }
  homing(from, to, rgb, { ms = 900, arc = 120, r = 4 } = {}) {
    const cx = (from.x + to.x) / 2 + rnd(-arc, arc), cy = Math.min(from.y, to.y) - rnd(arc * 0.3, arc);
    this.addP({ x: from.x, y: from.y, life: ms * rnd(0.85, 1.15), r, update: (p) => { const t = EASE.in(Math.min(1, p.t / p.life)); const u = 1 - t;
      p.px = p.x; p.py = p.y; p.x = u * u * from.x + 2 * u * t * cx + t * t * to.x; p.y = u * u * from.y + 2 * u * t * cy + t * t * to.y; },
    draw: (c, p) => { glow(c, p.x, p.y, p.r * 3.5, rgb, 0.95); c.strokeStyle = `rgba(${rgb},.5)`; c.lineWidth = p.r; c.beginPath(); c.moveTo(p.px ?? p.x, p.py ?? p.y); c.lineTo(p.x, p.y); c.stroke(); } });
  }
  twinkles(pt, { n = 10, r = 80, rgb = "160,230,255" } = {}) {
    for (let i = 0; i < n; i++) this.addP({ x: pt.x + rnd(-r, r), y: pt.y + rnd(-r, r) * 0.8, life: rnd(500, 900), s: rnd(5, 11) * this.U,
      draw: (c, p, t) => { const k = Math.sin(t * Math.PI) * p.s; glow(c, p.x, p.y, k * 2.5, rgb, 0.7); c.fillStyle = "#fff"; c.beginPath(); c.moveTo(p.x, p.y - k * 1.6); c.lineTo(p.x + k * 0.3, p.y); c.lineTo(p.x, p.y + k * 1.6); c.lineTo(p.x - k * 0.3, p.y); c.closePath(); c.fill();
        c.beginPath(); c.moveTo(p.x - k * 1.6, p.y); c.lineTo(p.x, p.y + k * 0.3); c.lineTo(p.x + k * 1.6, p.y); c.lineTo(p.x, p.y - k * 0.3); c.closePath(); c.fill(); } });
  }
  dustBurst(pt, { n = 14, s = 1, rgb = "190,170,140" } = {}) {
    for (let i = 0; i < n; i++) { const an = rnd(Math.PI, Math.PI * 2); this.addP({ x: pt.x + rnd(-10, 10) * s, y: pt.y, vx: Math.cos(an) * rnd(0.08, 0.25) * s, vy: Math.sin(an) * rnd(0.02, 0.1) * s, drag: 0.97, life: rnd(500, 900), r: rnd(8, 18) * s, comp: "source-over",
      draw: (c, p, t) => { c.fillStyle = `rgba(${rgb},${0.45 * (1 - t)})`; c.beginPath(); c.arc(p.x, p.y, p.r * (1 + t), 0, 7); c.fill(); } }); }
  }
  // a ghost of the wielder where it stands now, fading out (brightness(1.6) saturate(.4))
  afterimage({ opacity = 0.5, ms = 380 } = {}) {
    this.AF.push({ x: this.OX(), y: this.OY() - (this.A.lift + this.A.bob), h: this.hgtA(), w: this.widA(), rot: this.A.rot * Math.PI / 180, op: opacity, ms, t0: performance.now() });
  }
  drawAfterimages(g, now) {
    const art = this.tl.art("a"); if (!art) return; const T = this.TA;
    for (const f of this.AF) { const a = f.op * (1 - EASE.sine(Math.min(1, (now - f.t0) / f.ms))); if (a <= 0) continue;
      g.save(); g.translate(f.x, f.y); if (f.rot) g.rotate(f.rot); g.scale(T.flip, 1); g.globalAlpha = a; g.filter = "brightness(1.6) saturate(.4)";
      g.drawImage(art, -f.w / 2, -f.h * T.foot, f.w, f.h); g.restore(); }
  }

  // ── clips (timeline tracks pushed live; sizes as the mockup: native × scale × .55) ──
  clip(key, pt, { scale = 1, rot = 0, add = false, filter = "", rate = 1, z = 40, flip = false, h = null } = {}) {
    const def = CINE_CLIPS[key]; if (!def || !this.m) return null;
    const w = h != null ? def.w * h / def.h : def.w * scale * 0.55;
    const hold = { stopAt: null, ms: 300 };
    const flipX = flip !== (this.fl < 0);   // a wielder facing right mirrors the cut
    const rr = (this.fl < 0 ? -rot : rot) * Math.PI / 180;
    const f = add ? [filter, lumaFilter()].filter(Boolean).join(" ") : filter;   // additive = black-background art
    const c = this.m.clip(key, this.tNow, { x: pt.x, y: pt.y, w, rot: rr, flip: flipX, add, filter: f || undefined, rate, z, depth: false,
      alpha: () => (hold.stopAt == null ? 1 : Math.max(0, 1 - (performance.now() - hold.stopAt) / hold.ms)) });
    const tr = this.T[this.T.length - 1];
    if (c && !c.taking) c.take();   // its copy now (a pushed-live track has no lead time)
    return { stop: (ms = 300) => { hold.stopAt = performance.now(); hold.ms = ms; if (tr) tr.t1 = Math.min(tr.t1, this.tNow + ms + 20); return this.wait(ms).catch(() => {}); } };
  }
  // a pixelfx clip: back under the battlers, front over them, light added on top; h = drawn height
  pxfx(key, pt, h, { rate = 1 } = {}) {
    if (!CINE_CLIPS["px_" + key + "_front"]) return { stop: () => Promise.resolve() };
    const L = [this.clip("px_" + key + "_back", pt, { h, rate, z: 2 }), this.clip("px_" + key + "_front", pt, { h, rate, z: 39 }), this.clip("px_" + key + "_light", pt, { h, rate, z: 39.5, add: true })];
    return { stop: (ms = 300) => Promise.all(L.map((l) => l?.stop(ms))) };
  }
  muzzle(scale = 1) {
    const p = this.hand(), s = this.sA();
    this.clip("gg_burst_anim02", p, { scale: s * 0.55 * scale, filter: "sepia(1) saturate(6) hue-rotate(-12deg) brightness(1.3)", add: true, z: 44 });
    this.clip("gg_spark_anim01", p, { scale: s * 0.7 * scale, filter: "sepia(1) saturate(5) hue-rotate(-5deg) brightness(1.4)", add: true, z: 44.5 });
    for (let k = 0; k < 10; k++) this.addP({ x: p.x, y: p.y, vx: this.face * rnd(0.15, 0.5), vy: rnd(-0.25, 0.1), g: 0.0008, drag: 0.97, life: rnd(220, 420), r: rnd(1.5, 3), draw: (c, q, tt) => glow(c, q.x, q.y, q.r * 3, GOLD, 1 - tt) });
  }

  // ── the wielder (the mockup's lean / slide / moveActor, in drawn px) ──
  leanTo(deg, ms, ease = EASE.out) { const r0 = this.A.rot; return this.tween(ms, ease, (t) => { this.A.rot = lerp(r0, deg, t); }); }
  slide(dx, ms = 420, dy = this.A.dy, ease = EASE.quad) { const x0 = this.A.dx, y0 = this.A.dy; return this.tween(ms, ease, (t) => { this.A.dx = lerp(x0, dx, t); this.A.dy = lerp(y0, dy, t); }); }
  moveTo(x, y, ms, ease = EASE.sine, { hop = 0 } = {}) {
    const x0 = this.OX(), y0 = this.OY();
    return this.tween(ms, ease, (t) => { this.A.dx = lerp(x0, x, t) - this.TA.x; this.A.dy = lerp(y0, y, t) - this.homeA.y; this.A.bob = Math.sin(t * Math.PI) * hop * this.U; }).then(() => { this.A.bob = 0; });
  }
  async trailMove(x, y, ms) {
    let on = true;
    (async () => { while (on && this.alive) { this.afterimage({ opacity: 0.35, ms: 260 }); await this.wait(55); } })().catch(() => {});
    try { await this.moveTo(x, y, ms, EASE.quad, { hop: 8 }); } finally { on = false; }
  }
  async stepIn(ms = 520, snd = "move1") {
    sfx(snd, 0.45); const f = this.front(92);
    this.dustBurst(this.feetA(), { n: 8, s: this.sA() * 0.8 * this.U });
    await this.trailMove(f.x, f.y, ms);
  }
  async backHome() { sfx("jump1", 0.35); await this.moveTo(this.TA.x, this.homeA.y, 520, EASE.quad, { hop: 14 }); this.A.dx = 0; this.A.dy = 0; this.soft(this.leanTo(0, 120)); }

  // ═════════ the beats ═════════
  // Isolate + dash in
  async intro() {
    this.fx({ phase: "intro" });
    const z = CINE.zoom;
    this.soft(this.isolate(true));
    const onA = () => { const p = this.centerA(); return { x: p.x, y: p.y }; };
    this.camGo({ ...onA(), z: z * 1.25, r: 0 }, 260);
    if (CINE.pillar === 0) {
      const px = this.pxfx("lux", this.feetA(), this.hgtA() * 2.1, { rate: 1.7 }); sfx("limit", 0.5);
      const c = this.centerA();
      for (let k = 0; k < this.N(14); k++) this.homing({ x: this.OX() + rnd(-160, 160) * this.U, y: this.OY() - rnd(0, 220) * this.U }, c, "255,214,140", { ms: 600, arc: 40 * this.U, r: 2 * this.U });
      await this.wait(900); this.soft(px.stop(400));
    } else await this.wait(500);
    // the dash: the camera rides with the wielder toward the two-shot
    this.CD.follow = () => { const p = this.centerA(), q = this.twoShot(); return { x: lerp(p.x, q.x, 0.5), y: lerp(p.y, q.y, 0.5) }; };
    this.camGo({ z: z * 1.1, r: 0 }, 180);
    this.speedLines(true, { angle: this.face > 0 ? 0 : Math.PI, alpha: 0.35, n: 22 });
    this.fx({ phase: "dash" });
    await this.stepIn(520, "dash"); this.speedLines(false);
    this.CD.follow = null; this.camGo({ ...this.twoShot(), z, r: 0 }, 300); await this.wait(250);
  }

  // one strike: five different cuts; a TRIGGER fires the gun through the blade
  async strike(i, hit) {
    this.fx({ phase: "strike", info: { i, hit } });
    const cut = CUTS[i % CUTS.length], fl = this.fl, N = (n) => this.N(n);
    await this.leanTo(-cut.lean * 0.4 * fl, 70); sfx(i % 2 ? "sword4" : "sword2", 0.38);
    this.soft(this.slide(this.A.dx + this.face * -cut.dx * this.U, 120, this.A.dy)); this.afterimage({ opacity: 0.45, ms: 240 });
    // camera: each slash pushes a step further in and tilts the other way
    if (this.CD.on) { const side = i % 2 ? 1 : -1, z0 = CINE.zoom * (1 + CINE.zstep / 100 * (i + 1));
      this.camGo({ ...this.twoShot(), z: z0, r: side * CINE.tilt * (hit ? 1 : 0.6) }, 260); this.CD.punch = CINE.punch / 100 * (hit ? 1.6 : 1); }
    await this.leanTo(cut.lean * fl, 80);
    const c = this.centerT(), ts = this.sT(), ht = this.hgtT();
    this.clip(hit ? "007_slash_effect" : "006_slash_physical", c, { scale: ts * (hit ? 1.25 : 1), rot: cut.rot, z: 40 });
    const L = ht * (hit ? 1.05 : 0.85); let ang = (cut.sw + rnd(-6, 6)) * Math.PI / 180; if (fl < 0) ang = Math.PI - ang;
    this.slashSheet(c, ang, { L, w: (hit ? 34 : 24) * ts * this.U, rgb: STEEL, ms: hit ? 340 : 280, core: hit ? 0.38 : 0.3 });
    this.sparks(c, N(hit ? 16 : 7), GOLD, hit ? 1.1 : 0.7);
    if (hit) {
      this.muzzle(); sfx("gunshot", 0.55); sfx("slashL", 0.45); this.clip("002_hit_effect", c, { scale: ts * 0.9, z: 42 });
      // TRIGGER: fire burst + red bloom + one white frame + rays + chromatic split + embers, then a short hit-stop
      this.clip("gg_fireanim02", c, { scale: ts * 0.8, add: true, z: 43, rate: 1.4 });
      this.bloom(c, ht * 1.1); this.impactRays(c, N(22), 26 * ts * this.U, 340 * ts * this.U);
      for (let k = 0; k < N(12); k++) this.ember(c.x + rnd(-40, 40) * ts * this.U, c.y + rnd(-50, 30) * ts * this.U, "255,80,40", { life: rnd(700, 1300), r: rnd(1.5, 3.5) * this.U });
      this.shake(7, 220); this.soft(this.flash("#fff", CINE.wframe / 100, 20, 110)); this.soft(this.chroma(CINE.chroma, 200)); this.shards(c, GOLD, N(8), 0.4);
    } else { sfx("slash1", 0.45); this.shake(3, 140); }
    await this.wait(hit ? 120 + CINE.hitstop : 60);
  }

  // Lion Heart (6/6 only): light pillar, deeper dim, push on the target, impact frame, starburst, sparkle dust
  async lionHeart() {
    this.fx({ phase: "finisher" });
    const z = CINE.zoom, c = this.centerT(), ts = this.sT(), ht = this.hgtT();
    this.soft(this.fdim(CINE.findim / 100, 380));
    const px = this.pxfx("ice", this.feetA(), this.hgtA() * 2.3, { rate: 2.2 }); sfx("limit", 0.5); sfx("shing", 0.4);
    this.camGo({ x: lerp(this.twoShot().x, c.x, 0.45), y: c.y, z: z * 1.3, r: 0 }, 420); this.twinkles(this.centerA(), { n: this.N(10), r: 70 * this.U, rgb: "160,220,255" });
    await this.wait(700);
    sfx("magnum", 0.55); await this.whiteTo(0.85, 90); this.soft(this.impactFrame(["t", "a"])); await this.whiteTo(0, 160);
    this.fx({ phase: "finisher-impact" });
    this.CD.punch = CINE.punch / 100 * 3; this.soft(this.chroma(CINE.chroma * 2.2, 420, 1.45));
    this.clip("023_slash_special_1", c, { scale: ts * 1.2, z: 45 }); sfx("crit", 0.55); sfx("slashL", 0.5); this.shake(14, 420);
    this.impactRays(c, this.N(40), 40 * ts * this.U, 700 * this.U, 520, "220,240,255"); this.bloom(c, ht * 1.8, "150,200,255", 600); this.sparks(c, this.N(30), "170,210,255", 1.4);
    for (let k = 0; k < this.N(40); k++) this.dust(c.x + rnd(-220, 220) * this.U, c.y + rnd(-160, 120) * this.U, k % 3 ? "200,230,255" : "255,236,180", { life: rnd(1200, 2200), r: rnd(1, 2.4) * this.U, vy: rnd(-0.05, -0.01) });
    await this.wait(900); this.soft(px.stop(500)); this.soft(this.fdim(CINE.dim / 100, 500));
  }

  // Result + restore + back
  async result() {
    this.restoring = true;
    const d = this.doneReq ?? {}, perfect = d.hits != null && d.count != null ? d.hits >= d.count : !!d.perfect;
    if (this.doneReq?.tier != null || this.doneReq?.hits != null) sfx(perfect || d.tier === "Perfect" ? "flash2" : "confirm", 0.35);
    this.fx({ phase: "restore" });
    await this.wait(250);
    await Promise.all([this.camHome(CINE.camBack), this.isolate(false, 1.2), this.backHome()]);
    await this.wait(500 + 250);
  }

  // ── endings ──
  end() { if (this.ended) return; this.ended = true; this.alive = false; this.kick(); if (!this.runP) this.teardown(); }
  // everything back now (camera, CSS, tokens, the authority); the timeline ends on its next frame
  abort(why = "abort") {
    if (this.tornDown) return;
    log(`${TAG}: abort (${why})`);
    this.alive = false; this.ended = true; this.kick();
    this.teardown();
  }
  teardown() {
    if (this.tornDown) return; this.tornDown = true;
    this.alive = false; this.ended = true;
    clearTimeout(this.watchdog);
    try {
      if (canvas?.ready && this.camOwned) { try { this.applyView(restViewFor(canvas.scene)); } catch (_) {} }
      for (const el of [canvas?.app?.view].filter(Boolean)) { el.style.rotate = ""; el.style.scale = ""; el.style.filter = ""; el.style.translate = ""; }
    } catch (_) {}
    try { this.oni?.dispose?.(); } catch (_) {}
    if (this.resumeCam) { try { this.resumeCam(); } catch (_) {} this.resumeCam = null; }
    if (this.followHeld) { try { globalThis.__ONI_MOVEMENT_CONTROL_CAMERA_RUNTIME__?.releaseCamera?.(FOLLOW_HOLD); } catch (_) {} this.followHeld = false; }
    this.camOwned = false;
    runs.delete(this.id);
    const st = canvas?.stage;
    this.fx({ phase: "end", info: { view: st ? { x: Math.round(st.pivot.x), y: Math.round(st.pivot.y), scale: +st.scale.x.toFixed(4) } : null } });
    log(`${TAG}: end`);
  }
}

function startRun(requestId, spec) {
  for (const [id, c] of runs) if (id !== requestId) c.abort("a newer run");
  if (runs.has(requestId)) return;
  const c = new Cine(requestId, spec);
  runs.set(requestId, c);
  // watchdog: the longest a run can take (the GM's own budget + the finisher + the restore)
  const t = TSG_TIMING, n = Number(spec?.count) || 6, per = (Number(spec?.sweepMs) || 650) + (Number(spec?.gapMs) || 260);
  const budget = 6000 + (Number(spec?.introMs) || t.introMs) + n * (per + 1500) + 6000 + t.tailMs + 4000;
  c.watchdog = setTimeout(() => c.abort("watchdog"), budget);
  c.start().catch((e) => { warn(`${TAG}: start threw`, e); c.abort("start threw"); });
}

Hooks.on(HOOK, (d = {}) => {
  try {
    switch (d.phase) {
      case "open": if (d.spec?.casterTokenId) startRun(d.requestId, d.spec); return;
      case "strike": runs.get(d.requestId)?.onStrike(d.i, !!d.hit); return;
      case "finisher": runs.get(d.requestId)?.onFinisher(); return;
      case "done": runs.get(d.requestId)?.onDone(d); return;
      case "close": runs.get(d.requestId)?.onClose(d); return;
      default: return;
    }
  } catch (e) { warn(`${TAG}: ${d.phase} threw`, e); }
});
Hooks.on("canvasTearDown", () => { for (const c of [...runs.values()]) c.abort("scene change"); });

// Warm the sounds once a battle is up (decode costs nothing audible later).
let _warmed = false;
Hooks.on("fu-battle-phase", () => {
  if (_warmed) return; _warmed = true;
  setTimeout(() => { preloadSfx(Object.values(CINE_SFX)).catch(() => {}); }, 3000);
});

// test seam
globalThis.FUCompanion ??= {};
globalThis.FUCompanion.api ??= {};
globalThis.FUCompanion.api.timedStrikeCinematic = { CINE, CINE_CLIPS, CINE_SFX, runs: () => [...runs.keys()], run: (id) => runs.get(id) ?? null, abortAll: () => { for (const c of [...runs.values()]) c.abort("api"); } };
