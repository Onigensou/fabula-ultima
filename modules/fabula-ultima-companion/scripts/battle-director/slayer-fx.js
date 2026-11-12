// slayer-fx.js — Slayer's shots (Bane Oils, Giant Killer, Lockdown) and their
// lingering cues, ported from the approved mockup v3 (2026-11-13):
// claude.ai/artifact/H7kodjsPFBHdSeufy2CqNM (source: part-slayer.js). Numbers,
// timings and sounds are the mockup's; drawing is procedural PIXI (no filters,
// glow = a few stacked low-alpha shapes), so nothing new had to be uploaded.
//
// SHOTS (called from the skills' animation scripts, which run on every client
// through pseudo.play; see tools/anim-studio/lib/slayer-signatures.js):
//   api.slayerFx.baneApply({ oni, caster, target, species })      vial, uncork, coat, sheen (+ lob to an ally)
//   api.slayerFx.baneProc({ oni, target, kind, species, element })  slow sludge / weak drain / ward shatter
//   api.slayerFx.giantKiller({ oni, target, n })                    hit-stop flash + tapered crimson notches
//   api.slayerFx.lockdownBind({ oni, caster, target })              MP motes, chains snap, sigil, sink to the feet
//   api.slayerFx.lockdownFlare({ oni, target })                     the locked action: chains flare and climb
// CUES (every client, display only), read from an ActiveEffect flag:
//   flags.fabula-ultima-companion.aeCue = { kind: "oilDrip", rgb: "236,140,48" }   oiled weapon: wet stroke, drips, glint
//                                       = { kind: "chainRing" }                     a slow chain ring at the feet;
//                                                                                    breaks apart when the AE ends
// Body-anchored drawing sits in canvas.primary on the unit mesh's own depth keys
// (back half a hair before the mesh, front half a hair after), placed on the mesh's
// rendered rect every frame, so the 3D stage's displaced, rescaled battler carries it.
// Sizes scale with the drawn body height (k = height / 250, the mockup's frame).

import { log, warn } from "./logger.js";
import { battleActive } from "./battle-focus.js";

const NS = "fabula-ultima-companion";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const SB = FORGE + "Sound/Soundboard/";
const SND = FORGE + "Sound/";
const MV = FORGE + "Animation/RPG%20Maker%20MV/";
const SFX = {
  item: SB + "Item1.ogg", pop: SND + "Klonoa/wood_pop_a.wav", liquid: SB + "Liquid.ogg", shing: SND + "Metal_Shing.mp3",
  swing: SB + "SE_SWINGA.wav", splash: SB + "Splash.ogg", powerup: SB + "Powerup.ogg", slow: SB + "Down2.ogg", down: SB + "Down1.ogg",
  crack: SB + "Parry.ogg", brk: SB + "Break.ogg", slashS: SB + "SE_BTL_HitSlashS.ogg", magic: SB + "Magic2.ogg",
  twine: SB + "Twine.ogg", key: SB + "Key.ogg", clank: SB + "Equip2.ogg", guard: SB + "SE_GUARDC.wav",
};
// RPG Maker MV clips (forge-mirror Animation/RPG Maker MV), anchor = the clip's feet/centre point
const CLIP = {
  powerup:   { url: MV + "051_powerup_1.webm",   w: 508, h: 790, ax: 0.5, ay: 0.543 },
  powerdown: { url: MV + "054_powerdown_1.webm", w: 508, h: 656, ax: 0.5, ay: 0.628 },
  slowdown:  { url: MV + "055_powerdown_2.webm", w: 384, h: 384, ax: 0.5, ay: 0.9375 },
  ring:      { url: FORGE + "Animation/Disgaea%204/webm/flash_ring_white.webm", w: 82, h: 82, ax: 0.5, ay: 0.5 },
};
// mockup palette, "r,g,b"
export const SPECIES = { beast: "236,140,48", construct: "84,186,255", demon: "226,38,72", elemental: "56,228,196",
  humanoid: "255,208,80", monster: "255,104,206", plant: "116,204,64", undead: "168,124,255" };
export const ELEMENT = { physical: "236,236,236", air: "72,199,116", bolt: "176,108,201", dark: "140,108,255", earth: "181,121,63",
  fire: "226,88,34", ice: "90,179,212", light: "212,187,95", poison: "63,174,108" };
const STEEL = "214,224,240", CHAIN = "110,170,255", CRIMSON = "255,38,60", MPBLUE = "90,170,255";

// Zarg's battler frame (174 x 250): the bow is in the art, held low across the body.
// Anyone else: a short line by the front hand (the mockup's Keren line).
const BOW = [[3, 88], [16, 98], [30, 112], [45, 128], [60, 140], [78, 150], [98, 156], [120, 152], [142, 144], [160, 138], [172, 134]];
const HAND = [[7, 95], [35, 137], [63, 175]];
const HIP = [104, 172], ABOVE = [60, 72];
const FRAME_W = 174, FRAME_H = 250;

// ───────── small maths
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);
const EASE = {
  lin: (t) => t, sine: (t) => 0.5 - Math.cos(Math.PI * t) / 2, out: (t) => 1 - (1 - t) * (1 - t),
  outCubic: (t) => 1 - Math.pow(1 - t, 3), inCubic: (t) => t * t * t, in: (t) => t * t,
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
};
const hex = (rgb) => { const [r, g, b] = String(rgb).split(",").map((v) => clamp(Math.round(Number(v) || 0), 0, 255)); return (r << 16) | (g << 8) | b; };
const lighten = (rgb, f) => String(rgb).split(",").map((v) => Math.round(Number(v) + (255 - Number(v)) * f)).join(",");
const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
function tween(ms, ease, fn) {
  return new Promise((resolve) => {
    const t0 = performance.now(), d = Math.max(1, ms);
    const step = () => {
      const u = clamp((performance.now() - t0) / d, 0, 1);
      try { fn(ease(u)); } catch (e) { warn("[slayer-fx] tween threw", e); }
      if (u >= 1) return resolve();
      requestAnimationFrame(step);
    };
    step();
  });
}
function sfx(oni, url, vol = 1, rate = 1, cutMs = 0) {
  try {
    if (oni?.sfx) return oni.sfx(url, { volume: vol, rate, ...(cutMs ? { fadeAfter: cutMs, fadeMs: 40 } : {}) });
    const a = new Audio(url); a.volume = clamp(vol, 0, 1); a.playbackRate = rate; a.play().catch(() => {});
    if (cutMs) setTimeout(() => { try { a.pause(); } catch { /* */ } }, cutMs);
    return a;
  } catch { return null; }
}

// ───────── where a battler is drawn (primary space)
const tokOf = (t) => (t?.object ?? t) || null;
function rectOf(token) {
  const t = tokOf(token), mesh = t?.mesh, prim = canvas.primary;
  if (!mesh || mesh.destroyed || !prim) return null;
  try {
    const b = mesh.getBounds(false);
    if (!b || !(b.width > 0) || !(b.height > 0)) return null;
    const tl = prim.worldTransform.applyInverse(new PIXI.Point(b.x, b.y));
    const br = prim.worldTransform.applyInverse(new PIXI.Point(b.x + b.width, b.y + b.height));
    const w = br.x - tl.x, h = br.y - tl.y;
    return { x: tl.x, y: tl.y, w, h, cx: tl.x + w / 2, cy: tl.y + h / 2, feet: br.y, k: h / FRAME_H, flip: (mesh.scale?.x ?? 1) < 0 ? -1 : 1 };
  } catch { return null; }
}
// a point given in the 174 x 250 battler frame
function framePt(R, px, py) {
  const fx = R.flip < 0 ? FRAME_W - px : px;
  return { x: R.x + (fx / FRAME_W) * R.w, y: R.y + (py / FRAME_H) * R.h };
}
const isZarg = (token) => /^zarg$/i.test(String(tokOf(token)?.actor?.name ?? "").trim());
const weaponPts = (token, R) => (isZarg(token) ? BOW : HAND).map(([x, y]) => framePt(R, x, y));
const meshShown = (t) => !!(t && !t.destroyed && t.visible && t.mesh && !t.mesh.destroyed && t.mesh.visible && t.mesh.worldAlpha > 0.05);

function cumLen(P) { const L = [0]; for (let i = 1; i < P.length; i++) L.push(L[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y)); return L; }
function along(P, u) {
  const L = cumLen(P), d = clamp(u, 0, 1) * L[L.length - 1];
  for (let i = 1; i < P.length; i++) if (d <= L[i]) { const f = (d - L[i - 1]) / Math.max(1e-6, L[i] - L[i - 1]); return { x: lerp(P[i - 1].x, P[i].x, f), y: lerp(P[i - 1].y, P[i].y, f) }; }
  return P[P.length - 1];
}
function partial(P, u) {
  const L = cumLen(P), d = clamp(u, 0, 1) * L[L.length - 1], out = [P[0]];
  for (let i = 1; i < P.length; i++) {
    if (L[i] <= d) { out.push(P[i]); continue; }
    const f = (d - L[i - 1]) / Math.max(1e-6, L[i] - L[i - 1]); out.push({ x: lerp(P[i - 1].x, P[i].x, f), y: lerp(P[i - 1].y, P[i].y, f) }); break;
  }
  return out;
}

// ───────── drawing primitives on a PIXI.Graphics
function glow(g, x, y, r, rgb, a) {
  if (!(a > 0.01) || !(r > 0.2)) return;
  const c = hex(rgb);
  g.beginFill(c, 0.10 * a); g.drawCircle(x, y, r); g.endFill();
  g.beginFill(c, 0.18 * a); g.drawCircle(x, y, r * 0.6); g.endFill();
  g.beginFill(c, 0.35 * a); g.drawCircle(x, y, r * 0.3); g.endFill();
}
function polyline(g, P, width, color, alpha) {
  if (P.length < 2) return;
  g.lineStyle({ width, color, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
  g.moveTo(P[0].x, P[0].y); for (let i = 1; i < P.length; i++) g.lineTo(P[i].x, P[i].y);
  g.lineStyle(0);
}
// the Wet-cue drop (status-cues.js .dr): 4k x 7k, pale top, coloured body, a 2 px glow
function drawDrop(g, x, y, k, rgb, a, stretch = 1) {
  if (!(a > 0.01)) return;
  const w = 2 * k, h = 7 * k * stretch;
  g.beginFill(hex(rgb), 0.35 * a); g.drawEllipse(x, y, w * 1.6, h * 0.62); g.endFill();
  g.beginFill(hex(rgb), a); g.drawEllipse(x, y + h * 0.1, w, h * 0.5); g.endFill();
  g.beginFill(hex(lighten(rgb, 0.85)), a * 0.9); g.drawEllipse(x - w * 0.25, y - h * 0.12, w * 0.45, h * 0.22); g.endFill();
}
// a tapered blade cut: zero width at both tips, widest 62% of the way to the lead
function sliver(g, x0, y0, x1, y1, wmax, color, alpha) {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, P = 0.62, N = 18;
  const w = (u) => wmax * (u < P ? Math.pow(Math.sin(Math.PI / 2 * u / P), 0.9) : Math.cos(Math.PI / 2 * (u - P) / (1 - P)));
  const pts = [];
  for (let i = 0; i <= N; i++) { const u = i / N, h = w(u); pts.push(x0 + dx * u + nx * h, y0 + dy * u + ny * h); }
  for (let i = N; i >= 0; i--) { const u = i / N, h = w(u); pts.push(x0 + dx * u - nx * h, y0 + dy * u - ny * h); }
  g.beginFill(color, alpha); g.drawPolygon(pts); g.endFill();
}

// ───────── a body-keyed drawing host: back + front Graphics on the unit's depth keys,
// plus a top Graphics on the stage for things crossing the field (motes, a lobbed vial)
const Z_EPS = 0.001;
function copyKeys(o, mesh, dz) {
  const z = (mesh.zIndex ?? 0) + dz;
  if (o.elevation !== mesh.elevation || o.sortLayer !== mesh.sortLayer || o.sort !== mesh.sort || o.zIndex !== z) {
    o.elevation = mesh.elevation; o.sortLayer = mesh.sortLayer; o.sort = mesh.sort; o.zIndex = z;
    if (canvas.primary) canvas.primary.sortDirty = true;
  }
}
class Host {
  constructor(token) {
    this.token = tokOf(token);
    this.back = new PIXI.Graphics(); this.front = new PIXI.Graphics(); this.top = new PIXI.Graphics();
    for (const g of [this.back, this.front, this.top]) g.eventMode = "none";
    canvas.primary?.addChild(this.back); canvas.primary?.addChild(this.front);
    canvas.stage.sortableChildren = true; this.top.zIndex = 95005; canvas.stage.addChild(this.top);
    this.parts = []; this.layers = []; this.alive = true; this.R = null;
    this._tick = () => this.frame();
    canvas.app.ticker.add(this._tick, null, PIXI.UPDATE_PRIORITY.LOW);
    this.last = performance.now();
  }
  add(p) { this.parts.push(Object.assign({ t: 0, life: 600, vx: 0, vy: 0, g: 0, drag: 1, layer: "front" }, p)); }
  frame() {
    if (!this.alive) return;
    const now = performance.now(), dt = Math.min(60, now - this.last); this.last = now;
    const t = this.token;
    this.R = (t && !t.destroyed) ? (rectOf(t) ?? this.R) : this.R;
    if (t?.mesh && !t.mesh.destroyed) { copyKeys(this.back, t.mesh, -Z_EPS); copyKeys(this.front, t.mesh, Z_EPS); }
    for (const g of [this.back, this.front, this.top]) g.clear();
    const G = { back: this.back, front: this.front, top: this.top };
    for (const L of this.layers) { try { L(G, this.R, dt, now); } catch (e) { warn("[slayer-fx] layer threw", e); } }
    for (const p of this.parts) {
      p.t += dt; p.vy += p.g * dt; p.vx *= p.drag; p.vy *= p.drag; p.x += p.vx * dt; p.y += p.vy * dt;
      const u = clamp(p.t / p.life, 0, 1);
      try { p.draw(G[p.layer] ?? this.front, p, u); } catch { /* */ }
    }
    this.parts = this.parts.filter((p) => p.t < p.life);
  }
  async settle(extraMs = 0) { await wait(extraMs); const end = performance.now() + 4000; while (this.parts.length && performance.now() < end) await wait(60); }
  destroy() {
    if (!this.alive) return; this.alive = false;
    try { canvas.app.ticker.remove(this._tick); } catch { /* */ }
    for (const g of [this.back, this.front, this.top]) { try { g.parent?.removeChild(g); g.destroy(); } catch { /* */ } }
  }
}
// particles (absolute primary coordinates)
function drop(H, pt, rgb, k, o = {}) {
  H.add({ x: pt.x, y: pt.y, vx: rnd(-0.012, 0.012), vy: 0.01, g: 0.0008, life: rnd(520, 820), k: rnd(0.75, 1.2) * k, ...o,
    draw: (g, p, u) => drawDrop(g, p.x, p.y, p.k, rgb, 1 - u * u, 1 + Math.min(0.6, Math.abs(p.vy) * 2)) });
}
function splashAt(H, pt, rgb, n, k, spread = 0.32) {
  for (let i = 0; i < n; i++) { const a = rnd(0, Math.PI * 2), sp = rnd(0.06, spread);
    drop(H, pt, rgb, k * rnd(0.9, 1.5), { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.12, g: 0.0012, drag: 0.99, life: rnd(420, 720) }); }
}
function shards(H, pt, rgb, n, sp, layer = "front") {
  for (let i = 0; i < n; i++) { const a = rnd(0, Math.PI * 2), v = rnd(0.08, sp), sz = rnd(2, 5), rot = rnd(0, 6);
    H.add({ x: pt.x, y: pt.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.08, g: 0.0009, drag: 0.985, life: rnd(380, 700), layer,
      draw: (g, p, u) => { const s = sz * (1 - u * 0.4), r = rot + u * 6;
        g.beginFill(hex(rgb), 1 - u); g.drawPolygon([p.x + Math.cos(r) * s, p.y + Math.sin(r) * s, p.x + Math.cos(r + 2.3) * s * 0.6, p.y + Math.sin(r + 2.3) * s * 0.6, p.x + Math.cos(r + 4) * s * 0.8, p.y + Math.sin(r + 4) * s * 0.8]); g.endFill(); } }); }
}
function homing(H, from, toFn, rgb, ms, arc, r) {
  const t0 = performance.now(), off = rnd(-1, 1) * arc, d = ms * rnd(0.85, 1.1);
  H.add({ x: from.x, y: from.y, life: d, layer: "top", draw: (g, p, u) => { const to = toFn(); const e = EASE.inCubic(u) * 0.6 + u * 0.4;
    p.x = lerp(from.x, to.x, e) + Math.sin(u * Math.PI) * off * 0.5; p.y = lerp(from.y, to.y, e) - Math.sin(u * Math.PI) * Math.abs(off);
    glow(g, p.x, p.y, r * 3, rgb, u < 0.85 ? 1 : (1 - u) / 0.15); g.beginFill(0xffffff, 0.9 * (1 - u * 0.5)); g.drawCircle(p.x, p.y, r * 0.5); g.endFill(); } });
}
// an MV / D4 clip at a point, sized by the body it plays on
async function clipAt(oni, c, x, y, width, { alpha = 1, tint = null, add = false } = {}) {
  if (!oni?.vfx) return null;
  try {
    const fx = await oni.vfx(c.url, { x, y, size: width, alpha, blend: add ? PIXI.BLEND_MODES.ADD : null });
    if (fx?.sprite) { fx.sprite.anchor.set(c.ax, c.ay); fx.sprite.position.set(x, y); if (tint != null) fx.sprite.tint = tint; }
    return fx;
  } catch { return null; }
}
// The mockup's flinch (hitReact). In game the battler's mesh belongs to the 3D stage
// and the idle bounce, and BD's own damage float already flinches a struck unit, so
// these shots never move the mesh: the call is kept where the mockup flinched, as a no-op.
async function jolt() { /* intentionally empty: see above */ }
// a white (or tinted) copy of the battler flashed on top of it
function bodyFlash(H, token, rgb, ms, peak = 0.9) {
  const t = tokOf(token), m = t?.mesh; if (!m?.texture) return null;
  const spr = new PIXI.Sprite(m.texture); spr.eventMode = "none"; spr.blendMode = PIXI.BLEND_MODES.ADD; spr.tint = hex(rgb);
  canvas.primary?.addChild(spr);
  const t0 = performance.now();
  H.layers.push(() => {
    if (spr.destroyed) return;
    const u = (performance.now() - t0) / ms;
    if (u >= 1 || m.destroyed) { try { spr.destroy(); } catch { /* */ } return; }
    spr.anchor.copyFrom(m.anchor); spr.position.copyFrom(m.position); spr.scale.copyFrom(m.scale); spr.rotation = m.rotation;
    copyKeys(spr, m, Z_EPS * 2); spr.alpha = peak * (u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8);
  });
  return spr;
}

// ═════════ BANE OILS
function vialLayer(H, v) {
  H.layers.push((G) => {
    if (!v.shown) return; const g = G.top, s = v.s * v.sc; if (!(s > 0.02)) return;
    const c = hex(v.rgb); const r = 9 * s;
    const ca = Math.cos(v.rot * Math.PI / 180), sa = Math.sin(v.rot * Math.PI / 180);
    const P = (x, y) => ({ x: v.x + (x * ca - y * sa), y: v.y + (x * sa + y * ca) });
    glow(g, v.x, v.y, 18 * s, v.rgb, 0.6);
    const b = P(0, 4 * s); g.beginFill(c, 0.95); g.drawCircle(b.x, b.y, r); g.endFill();
    g.lineStyle(1.3 * s, 0xebf8ff, 0.95); g.drawCircle(b.x, b.y, r); g.lineStyle(0);
    const n0 = P(-2.5 * s, -14 * s), n1 = P(2.5 * s, -14 * s), n2 = P(2.5 * s, -4 * s), n3 = P(-2.5 * s, -4 * s);
    g.beginFill(c, 0.55); g.drawPolygon([n0.x, n0.y, n1.x, n1.y, n2.x, n2.y, n3.x, n3.y]); g.endFill();
    g.lineStyle(1.1 * s, 0xebf8ff, 0.9); g.moveTo(n0.x, n0.y); g.lineTo(n3.x, n3.y); g.moveTo(n1.x, n1.y); g.lineTo(n2.x, n2.y); g.lineStyle(0);
    if (v.corked) { const k0 = P(-3.6 * s, -20 * s), k1 = P(3.6 * s, -20 * s), k2 = P(3.6 * s, -14 * s), k3 = P(-3.6 * s, -14 * s);
      g.beginFill(0x8a5a32, 1); g.drawPolygon([k0.x, k0.y, k1.x, k1.y, k2.x, k2.y, k3.x, k3.y]); g.endFill(); }
  });
  v.mouth = () => { const r = v.rot * Math.PI / 180, d = -18 * v.s * v.sc; return { x: v.x - Math.sin(r) * d, y: v.y + Math.cos(r) * d }; };
}
// the wet stroke along a weapon line (Graphics layer), with a sheen that can sweep along it
function coatLayer(H, token, rgb, o) {
  H.layers.push((G, R) => {
    if (!R || o.k <= 0) return; const P = partial(weaponPts(token, R), o.k), s = R.k;
    polyline(G.front, P, 8 * s, hex(rgb), 0.32 * o.a);
    polyline(G.front, P, 3.2 * s, hex(rgb), 0.92 * o.a);
    polyline(G.front, P, 1 * s, 0xffffff, 0.55 * o.a);
    if (o.glint >= 0 && o.glint <= 1) { const q = along(weaponPts(token, R), o.glint * o.k);
      glow(G.front, q.x, q.y, 24 * s, rgb, 0.75); glow(G.front, q.x, q.y, 9 * s, "255,255,255", 1);
      G.front.lineStyle(1.4, 0xffffff, 0.9); G.front.moveTo(q.x - 9 * s, q.y); G.front.lineTo(q.x + 9 * s, q.y); G.front.moveTo(q.x, q.y - 9 * s); G.front.lineTo(q.x, q.y + 9 * s); G.front.lineStyle(0); }
  });
}

/** Bane Oils: the apply. caster = Zarg (holds the vial), target = the weapon's owner (self, or an ally). */
export async function baneApply({ oni = null, caster, target = null, species = "beast" } = {}) {
  const C = tokOf(caster); if (!C || !rectOf(C)) return;
  const T = tokOf(target) ?? C, self = T.id === C.id;
  const rgb = SPECIES[species] ?? SPECIES.beast;
  const H = new Host(C);
  try {
    let R = rectOf(C); const v = { x: 0, y: 0, rot: 20, sc: 0.01, s: R.k * 1.0, rgb, corked: true, shown: true };
    vialLayer(H, v);
    // 1. draw a vial: hip → above the bow (260 ms, outBack)
    const a = framePt(R, ...HIP), b = framePt(R, ...ABOVE); sfx(oni, SFX.item, 0.5);
    await tween(260, EASE.outBack, (u) => { v.x = lerp(a.x, b.x, u); v.y = lerp(a.y, b.y, u); v.sc = Math.max(0.01, u); v.rot = lerp(20, 0, u); });
    // 2. uncork: pop, cork flies, a splash
    sfx(oni, SFX.pop, 0.7); v.corked = false;
    const m = v.mouth(); H.add({ x: m.x, y: m.y, vx: rnd(0.05, 0.1), vy: -0.34, g: 0.0011, life: 760, layer: "top",
      draw: (g, p, u) => { g.beginFill(0x8a5a32, u > 0.8 ? (1 - u) / 0.2 : 1); g.drawRect(p.x - 3.6 * v.s, p.y - 3 * v.s, 7.2 * v.s, 6 * v.s); g.endFill(); } });
    for (let i = 0; i < 4; i++) drop(H, v.mouth(), rgb, R.k, { vx: rnd(-0.06, 0.06), vy: rnd(-0.2, -0.1), g: 0.0012, layer: "top" });
    await tween(200, EASE.lin, (u) => { v.rot = Math.sin(u * Math.PI * 3) * 9 * (1 - u); });
    // 3. coat
    const coat = { k: 0, a: 1, glint: -1 };
    if (self) {
      coatLayer(H, C, rgb, coat); sfx(oni, SFX.liquid, 0.6);
      await tween(120, EASE.out, (u) => { v.rot = lerp(0, -118, u); });
      let last = 0;
      await tween(480, EASE.sine, (u) => { coat.k = u; R = rectOf(C) ?? R; const q = along(weaponPts(C, R), u); v.x = q.x + 6 * R.k; v.y = q.y - 30 * R.k;
        if (u - last > 0.05) { last = u; drop(H, v.mouth(), rgb, R.k * 0.8, { vy: 0.12, life: 260 }); } });
    } else {
      const from = { x: v.x, y: v.y }, TR = rectOf(T) ?? R, to = { x: TR.cx, y: TR.cy }; sfx(oni, SFX.swing, 0.5);
      await tween(520, EASE.lin, (u) => { v.x = lerp(from.x, to.x, u); v.y = lerp(from.y, to.y, u) - Math.sin(u * Math.PI) * 110 * R.k; v.rot = u * 540; });
      v.shown = false; sfx(oni, SFX.splash, 0.7); sfx(oni, SFX.pop, 0.3, 1.4);
      splashAt(H, to, rgb, 26, TR.k * 1.2, 0.4); bodyFlash(H, T, rgb, 420, 0.55);
      const H2 = new Host(T); coatLayer(H2, T, rgb, coat); H.on2 = H2;
      await tween(260, EASE.out, (u) => { coat.k = u; });
    }
    // 4. sheen + buff beat (MV 051 + Powerup)
    if (v.shown) { const v0 = v.sc; tween(200, EASE.in, (u) => { v.sc = v0 * (1 - u); }).then(() => { v.shown = false; }); }
    sfx(oni, SFX.shing, 0.45);
    const WR = rectOf(T) ?? R;
    clipAt(oni, CLIP.powerup, WR.cx, WR.feet, WR.h * 1.25, { alpha: 0.9 });
    sfx(oni, SFX.powerup, 0.45);
    await tween(300, EASE.sine, (u) => { coat.glint = u; }); coat.glint = -1;
    // the stroke hands over to the lingering cue (aeCue oilDrip), which fades in on its own
    await tween(380, EASE.sine, (u) => { coat.a = 1 - u; });
    if (H.on2) H.on2.destroy();
    await H.settle(120);
  } finally { if (H.on2) H.on2.destroy(); H.destroy(); }
}

/** Bane Oils: the hit's bane. kind = "slow" | "weak" | "res". */
export async function baneProc({ oni = null, target, kind = "slow", species = "beast", element = "physical" } = {}) {
  const T = tokOf(target); let R = rectOf(T); if (!T || !R) return;
  const rgb = SPECIES[species] ?? SPECIES.beast;
  const H = new Host(T);
  try {
    if (kind === "slow") {
      // heavy sludge: the Wet drop, bigger (7x13 per k) and slower, from the head and shoulders; it pools at the feet
      sfx(oni, SFX.slow, 0.55); clipAt(oni, CLIP.slowdown, R.cx, R.feet, R.h * 1.05);
      for (let i = 0; i < 10; i++) {
        const d = rnd(2200, 3300), x0 = rnd(-0.22, 0.22), y0 = rnd(0.14, 0.38), delay = rnd(0, 700);
        H.add({ x: 0, y: 0, life: d + delay, draw: (g, p, u) => { const R2 = H.R ?? R; const tt = (p.t - delay) / d; if (tt < 0) return;
          const top = R2.y + R2.h * y0, fall = (R2.feet - R2.h * 0.03) - top, e = tt < 0.12 ? 0 : Math.pow((tt - 0.12) / 0.88, 2.2);
          drawDrop(g, R2.cx + x0 * R2.w, top + fall * e, R2.k * 1.8, rgb, tt < 0.12 ? tt / 0.12 : tt > 0.94 ? (1 - tt) / 0.06 : 0.95, 1.1); } });
      }
      for (let i = 0; i < 3; i++) {
        const d = rnd(1300, 1700), delay = 700 + i * 500, dx = rnd(-0.15, 0.15);
        H.add({ x: 0, y: 0, life: d + delay, layer: "back", draw: (g, p) => { const R2 = H.R ?? R; const tt = (p.t - delay) / d; if (tt < 0) return;
          const sc = lerp(0.3, 1.5, tt), a = tt < 0.2 ? tt / 0.2 * 0.9 : 0.9 * (1 - (tt - 0.2) / 0.8);
          g.lineStyle(1.5 * R2.k, hex(rgb), a); g.drawEllipse(R2.cx + dx * R2.w, R2.feet - R2.h * 0.03, 13 * R2.k * sc, 4 * R2.k * sc); g.lineStyle(0); } });
      }
      jolt(T, 3, 220);
      await wait(1900);
    } else if (kind === "weak") {
      sfx(oni, SFX.down, 0.55); clipAt(oni, CLIP.powerdown, R.cx, R.feet, R.h * 1.2);
      for (let i = 0; i < 18; i++) {
        const x = R.cx + rnd(-0.35, 0.35) * R.w, y = R.feet - R.h * rnd(0.15, 0.85), rr = rnd(2, 3.4) * R.k;
        H.add({ x, y, vx: rnd(-0.015, 0.015), vy: rnd(-0.07, -0.03), life: rnd(700, 1200), draw: (g, p, u) => glow(g, p.x, p.y, rr * 3, u < 0.3 ? rgb : "200,200,210", Math.sin(u * Math.PI) * 0.8) });
      }
      // the colour drains: a grey wash over the body (a dimmed copy), then back
      const spr = bodyFlash(H, T, "120,120,135", 1800, 0.55); if (spr) spr.blendMode = PIXI.BLEND_MODES.MULTIPLY;
      await wait(1800);
    } else {
      // Lose a Resistance: a ward in the element's colour shows, cracks, and shatters
      const erb = ELEMENT[element] ?? ELEMENT.physical, w = { a: 0, sc: 0.9, crack: 0, on: true };
      const cracks = Array.from({ length: 7 }, (_, i) => { const a0 = Math.PI + (i - 3) * 0.5; const pts = [[0, 0]]; let x = 0, y = 0;
        for (let j = 0; j < 5; j++) { const a = a0 + rnd(-0.55, 0.55); x += Math.cos(a) * -0.24; y += Math.sin(a) * 0.24; pts.push([x, y]); } return pts; });
      H.layers.push((G, R2) => {
        if (!w.on || !R2 || w.a <= 0.01) return; const g = G.front, c = hex(erb);
        const RX = (R2.w * 0.8 * 0.62 + 12 * R2.k) * w.sc, RY = R2.h * 0.6 * 0.62 * w.sc, cx = R2.cx, cy = R2.feet - R2.h * 0.45;
        g.beginFill(c, 0.10 * w.a); g.drawEllipse(cx, cy, RX, RY); g.endFill();
        g.beginFill(c, 0.08 * w.a); g.drawEllipse(cx, cy, RX * 0.8, RY * 0.8); g.endFill();
        const hs = 13 * R2.k; g.lineStyle(1.2, c, 0.32 * w.a);
        for (let row = 0, yy = -RY; yy < RY; yy += hs * 1.5, row++) for (let xx = -RX + (row % 2) * hs * 0.866; xx < RX; xx += hs * 1.732) {
          if ((xx * xx) / (RX * RX) + (yy * yy) / (RY * RY) > 0.8) continue;
          const pts = []; for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; pts.push(cx + xx + Math.cos(a) * hs * 0.9, cy + yy + Math.sin(a) * hs * 0.9); }
          g.drawPolygon(pts);
        }
        g.lineStyle(7 * R2.k, c, 0.25 * w.a); g.drawEllipse(cx, cy, RX, RY);
        g.lineStyle(2.6 * R2.k, c, 0.95 * w.a); g.drawEllipse(cx, cy, RX, RY); g.lineStyle(0);
        if (w.crack > 0) { const ox = cx + RX * 0.55, oy = cy - RY * 0.1; g.lineStyle(2 * R2.k, 0xffffff, 0.95 * w.a);
          for (const cr of cracks) { const n = (cr.length - 1) * w.crack; g.moveTo(ox, oy);
            for (let j = 1; j < cr.length; j++) { if (j <= n) g.lineTo(ox + cr[j][0] * RX, oy + cr[j][1] * RY); else { const f = n - (j - 1); if (f > 0) g.lineTo(ox + lerp(cr[j - 1][0], cr[j][0], f) * RX, oy + lerp(cr[j - 1][1], cr[j][1], f) * RY); break; } } }
          g.lineStyle(0); }
      });
      sfx(oni, SFX.magic, 0.35, 1.3);
      await tween(220, EASE.outBack, (u) => { w.a = clamp(u, 0, 1); w.sc = 0.9 + 0.1 * u; }); await wait(160);
      sfx(oni, SFX.crack, 0.7); await tween(260, EASE.outCubic, (u) => { w.crack = u; }); await wait(90);
      w.on = false; R = rectOf(T) ?? R; const c0 = { x: R.cx, y: R.feet - R.h * 0.45 }; sfx(oni, SFX.brk, 0.85);
      shards(H, c0, erb, 26, 0.55); shards(H, c0, "255,255,255", 10, 0.45);
      clipAt(oni, CLIP.ring, c0.x, c0.y, R.h * 0.9, { tint: hex(erb), add: true });
      jolt(T, 6, 200); await wait(260);
      clipAt(oni, CLIP.powerdown, R.cx, R.feet, R.h * 1.1, { alpha: 0.8 }); sfx(oni, SFX.down, 0.3);
      await wait(800);
    }
    await H.settle();
  } finally { H.destroy(); }
}

// ═════════ GIANT KILLER
/** The rider's accent on the struck creature. n = soldiers replaced (bonus / 2). Kept under ~0.6 s. */
export async function giantKiller({ oni = null, target, n = 2 } = {}) {
  const T = tokOf(target); const R = rectOf(T); if (!T || !R) return;
  n = clamp(Math.round(n) || 2, 1, 8);
  const H = new Host(T);
  try {
    // hit-stop: the body flashes white with a crimson rim for 50 + 12n ms (the game can't freeze, so the flash holds the beat)
    const stop = 50 + 12 * n;
    H.layers.push((G, R2) => { if (!R2 || H.stopEnd < performance.now()) return; glow(G.back, R2.cx, R2.feet - R2.h * 0.5, R2.h * 0.55, CRIMSON, 0.5 + n * 0.05); });
    H.stopEnd = performance.now() + stop;
    bodyFlash(H, T, "255,255,255", stop + 60, 0.85);
    await wait(stop);
    jolt(T, n >= 4 ? 9 : 6, 200);
    sfx(oni, SFX.slashS, 0.14 + 0.015 * n, 1.15);
    try { oni?.screenshake?.({ duration: 150 + 25 * n, intensity: 3 + 2.2 * n }); } catch { /* */ }
    const gap = Math.min(42, 190 / n);
    for (let i = 0; i < n; i++) {
      const yf = 0.28 + 0.5 * (i + 0.5) / n, jx = rnd(-6, 6), jy = rnd(-4, 4), lenF = (1.05 + 0.05 * n) * rnd(0.9, 1.1), ang = (-26 + rnd(-9, 9)) * Math.PI / 180;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      H.add({ x: 0, y: 0, life: 560, draw: (g, p) => { const R2 = H.R ?? R, s = R2.k;
        const x = R2.cx + jx * s, y = R2.feet - R2.h * yf + jy * s, len = R2.w * 0.62 * lenF, th = (3 + n * 0.55) * s;
        const x0 = x - ca * len / 2, y0 = y - sa * len / 2, grow = Math.min(1, p.t / 70), fade = p.t < 190 ? 1 : 1 - (p.t - 190) / 370;
        const ex = x0 + ca * len * grow, ey = y0 + sa * len * grow, a = Math.max(0, fade);
        sliver(g, x0, y0, ex, ey, th * 2.4, hex(CRIMSON), 0.22 * a);
        sliver(g, x0, y0, ex, ey, th * 1.7, hex(CRIMSON), 0.55 * a);
        sliver(g, x0, y0, ex, ey, th * 0.75, hex(CRIMSON), a);
        sliver(g, x0 + (ex - x0) * 0.1, y0 + (ey - y0) * 0.1, ex - (ex - x0) * 0.06, ey - (ey - y0) * 0.06, th * 0.25, 0xffebeb, a); } });
      for (let k = 0; k < 4; k++) {
        const fx = rnd(0.2, 0.9), x = R.cx + (fx - 0.5) * R.w * 0.62 * lenF * ca, y = R.feet - R.h * yf + (fx - 0.5) * R.w * 0.62 * lenF * sa, rr = rnd(1.5, 3) * R.k;
        H.add({ x, y, vx: rnd(-0.12, 0.12), vy: rnd(-0.16, 0.02), g: 0.0006, life: rnd(260, 420), draw: (g, p, u) => glow(g, p.x, p.y, rr * 3, CRIMSON, 1 - u) });
      }
      if (i < n - 1) await wait(gap);
    }
    await H.settle();
  } finally { H.destroy(); }
}

// ═════════ LOCKDOWN — chain rings around a body
function ringsState() { return [0.3, 0.52, 0.74].map((h, i) => ({ h, k: 2.4, a: 0, glow: 0, ph: i * 0.7, spin: i % 2 ? -1 : 1 })); }
function drawRings(G, R, rings, spinMul, dt) {
  if (!R) return; const s = R.k;
  for (const Rg of rings) {
    Rg.ph += Rg.spin * 0.00035 * dt * spinMul;
    if (Rg.a <= 0.01) continue;
    const cy = R.feet - R.h * Rg.h, rx = (R.w * 0.62 * 0.62 + 6 * s) * Rg.k, ry = rx * 0.3, cx = R.cx;
    const n = Math.max(10, Math.round((Math.PI * (rx + ry)) / (9 * s))), L = 9.5 * s;
    for (let i = 0; i < n; i++) {
      const a = Rg.ph + i * Math.PI * 2 / n, front = Math.sin(a) > 0, g = front ? G.front : G.back;
      const x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry, tan = Math.atan2(Math.cos(a) * ry, -Math.sin(a) * rx);
      const al = Rg.a * (front ? 1 : 0.75);
      if (Rg.glow > 0.02) glow(g, x, y, L * 1.4, CHAIN, Rg.glow * 0.7 * al);
      const ca = Math.cos(tan), sa = Math.sin(tan), lx = L * 0.62, ly = (i % 2 ? L * 0.3 : L * 0.08);
      const pts = []; for (let k = 0; k < 10; k++) { const t = k / 10 * Math.PI * 2, ex = Math.cos(t) * lx, ey = Math.sin(t) * ly; pts.push(x + ex * ca - ey * sa, y + ex * sa + ey * ca); }
      g.lineStyle(2.2 * s, hex(front ? STEEL : "150,160,180"), al); g.drawPolygon(pts);
      g.lineStyle(0.8 * s, 0xffffff, 0.7 * al); g.moveTo(x - L * 0.3 * ca + L * 0.12 * sa, y - L * 0.3 * sa - L * 0.12 * ca); g.lineTo(x + L * 0.2 * ca + L * 0.12 * sa, y + L * 0.2 * sa - L * 0.12 * ca);
      g.lineStyle(0);
    }
  }
}
function sigil(H, R) {
  const cx = R.cx, cy = R.feet - R.h * 0.5, s = R.k;
  H.add({ x: cx, y: cy, life: 720, layer: "front", draw: (g, p, u) => {
    const sc = lerp(1.6, 1, EASE.outCubic(Math.min(1, u * 2.5))) * s, a = u < 0.5 ? 1 : 1 - (u - 0.5) / 0.5, c = hex(CHAIN);
    glow(g, cx, cy, 44 * sc, CHAIN, a * 0.8);
    g.lineStyle(3 * sc, c, a); g.drawEllipse(cx, cy, 34 * sc, 34 * sc * 0.9); g.lineStyle(1.5 * sc, c, a); g.drawEllipse(cx, cy, 26 * sc, 26 * sc * 0.9); g.lineStyle(0);
    for (let k = 0; k < 4; k++) { const r = k * Math.PI / 2 + Math.PI / 4, px = cx + Math.cos(r - Math.PI / 2) * 34 * sc, py = cy + Math.sin(r - Math.PI / 2) * 34 * sc * 0.9;
      g.beginFill(c, a); g.drawCircle(px, py, 4.5 * sc); g.endFill(); }
    g.beginFill(0xebf5ff, a); g.drawCircle(cx, cy - 5 * sc, 6 * sc); g.drawPolygon([cx - 4 * sc, cy - 2 * sc, cx + 4 * sc, cy - 2 * sc, cx + 6 * sc, cy + 12 * sc, cx - 6 * sc, cy + 12 * sc]); g.endFill();
  } });
}

/** Lockdown applied: MP motes from the caster, chains snap shut on the target, the sigil, then they sink to the feet. */
export async function lockdownBind({ oni = null, caster, target } = {}) {
  const C = tokOf(caster), T = tokOf(target); const RC = rectOf(C), RT = rectOf(T); if (!T || !RT) return;
  const H = new Host(T), HC = C && RC ? new Host(C) : null;
  _flaring.add(T.id);    // the lingering ring stays hidden until this shot hands over
  try {
    // spend 10 MP: Zarg flashes blue, motes travel (650 ms)
    sfx(oni, SFX.magic, 0.5);
    if (HC) { bodyFlash(HC, C, MPBLUE, 380, 0.7);
      for (let k = 0; k < 16; k++) homing(H, { x: RC.cx + rnd(-20, 20) * RC.k, y: RC.feet - RC.h * rnd(0.3, 0.7) }, () => { const R2 = H.R ?? RT; return { x: R2.cx, y: R2.feet - R2.h * 0.5 }; }, MPBLUE, 650, 80 * RC.k, 3 * RC.k); }
    await wait(650 * 0.95);
    // chains snap shut: three rings close in, 70 ms apart
    const rings = ringsState(); let spinMul = 0.2;
    H.layers.push((G, R2, dt) => drawRings(G, R2, rings, spinMul, dt));
    sfx(oni, SFX.twine, 0.65);
    await Promise.all(rings.map((Rg, i) => wait(i * 70).then(() => tween(240, EASE.outBack, (u) => { Rg.k = lerp(2.4, 1, u); Rg.a = Math.min(1, u * 2); Rg.glow = 1; }))));
    sfx(oni, SFX.key, 0.8); sfx(oni, SFX.clank, 0.55); sfx(oni, SFX.guard, 0.4);
    sigil(H, rectOf(T) ?? RT); jolt(T, 6, 200);
    try { oni?.screenshake?.({ duration: 220, intensity: 5 }); } catch { /* */ }
    await Promise.all(rings.map((Rg) => tween(500, EASE.out, (u) => { Rg.glow = 1 - 0.9 * u; })));
    await wait(150);
    // sink to a ring at the feet (the lingering aeCue chainRing takes over from here)
    spinMul = 1; sfx(oni, SFX.clank, 0.25, 0.8);
    await Promise.all(rings.map((Rg, i) => { const h0 = Rg.h, k0 = Rg.k, a0 = Rg.a || 1;
      return tween(520, EASE.inCubic, (u) => { Rg.h = lerp(h0, i * 0.012, u); Rg.k = lerp(k0, 1.3 + i * 0.08, u); Rg.a = lerp(a0, 0.5 - i * 0.1, u); Rg.glow = 0; }); }));
    await tween(260, EASE.sine, (u) => { for (const Rg of rings) Rg.a *= (1 - u * 0.25); });
  } finally { _flaring.delete(T.id); H.destroy(); HC?.destroy(); }
}

/** The locked action used: the ring flares, the chains climb and pull taut, then settle back. */
export async function lockdownFlare({ oni = null, target } = {}) {
  const T = tokOf(target); if (!T || !rectOf(T)) return;
  const H = new Host(T);
  _flaring.add(T.id);
  try {
    const rings = ringsState().map((Rg, i) => Object.assign(Rg, { h: i * 0.012, k: 1.3 + i * 0.08, a: 0.45 }));
    H.layers.push((G, R2, dt) => drawRings(G, R2, rings, 1, dt));
    sfx(oni, SFX.clank, 0.7); sfx(oni, SFX.guard, 0.55);
    await Promise.all(rings.map((Rg, i) => tween(200, EASE.outCubic, (u) => { Rg.h = lerp(i * 0.012, 0.32 + i * 0.2, u); Rg.k = lerp(1.3 + i * 0.08, 0.95, u); Rg.a = lerp(0.45, 1, u); Rg.glow = 1; })));
    sfx(oni, SFX.key, 0.6); jolt(T, 5, 160);
    await Promise.all(rings.map((Rg, i) => tween(420, EASE.inCubic, (u) => { Rg.h = lerp(0.32 + i * 0.2, i * 0.012, u); Rg.k = lerp(0.95, 1.3 + i * 0.08, u); Rg.a = lerp(1, 0.5 - i * 0.1, u); Rg.glow = 1 - u; })));
  } finally { _flaring.delete(T.id); H.destroy(); }
}
const _flaring = new Set();

// ═════════ LINGERING CUES (aeCue flag)
const CUES = new Map();      // `${tokenId}|${kind}` -> cue
let _hidden = false, _installed = false;
const DELAY = { oilDrip: 150, chainRing: 0 };

function cueSpecs(actor) {
  const out = [];
  try {
    for (const e of actor?.appliedEffects ?? actor?.effects ?? []) {
      if (e?.disabled) continue;
      const spec = e.flags?.[NS]?.aeCue;
      if (!spec?.kind || !DELAY[spec.kind]) continue;
      out.push({ kind: spec.kind, spec, aeId: e.id });
    }
  } catch { /* */ }
  return out;
}

function makeCue(token, s) {
  const H = new Host(token);
  const cue = { token, kind: s.kind, aeId: s.aeId, H, born: performance.now(), exit: null };
  if (s.kind === "oilDrip") {
    const rgb = String(s.spec.rgb || SPECIES.beast), coat = { k: 1, a: 0, glint: -1 };
    coatLayer(H, token, rgb, coat);
    const drops = Array.from({ length: isZarg(token) ? 7 : 4 }, () => ({ u: Math.random(), d: rnd(1100, 1800), ph: Math.random() }));
    let nextGlint = performance.now() + 900;
    H.layers.push((G, R, dt, now) => {
      if (!R) return; const fade = cueAlpha(cue, now); coat.a = 0.55 * fade;
      const on = battleActive() && !_hidden && meshShown(token);
      if (!on) { coat.a = 0; return; }
      if (now > nextGlint) { nextGlint = now + 1900; const t0 = now; const sweep = () => { const u = (performance.now() - t0) / 420; coat.glint = u >= 1 ? -1 : u; if (u < 1 && cue.H.alive) requestAnimationFrame(sweep); }; sweep(); }
      const P = weaponPts(token, R);
      for (const d of drops) {
        const tt = ((now / d.d) + d.ph) % 1, o = along(P, d.u), fall = R.h * 0.93 - (o.y - R.y);
        const e = tt < 0.12 ? 0 : tt < 0.3 ? (tt - 0.12) / 0.18 * 0.03 : 0.03 + Math.pow((tt - 0.3) / 0.7, 1.6) * 0.97;
        const a = (tt < 0.12 ? tt / 0.12 : tt > 0.94 ? (1 - tt) / 0.06 : 0.95) * fade;
        drawDrop(G.front, o.x, o.y + fall * e, R.k, rgb, a, tt < 0.12 ? 0.5 + tt / 0.24 : 1);
      }
    });
  } else {
    const rings = ringsState().map((Rg, i) => Object.assign(Rg, { h: i * 0.012, k: 1.3 + i * 0.08, a: 0 }));
    cue.rings = rings;
    H.layers.push((G, R, dt, now) => {
      const on = battleActive() && !_hidden && meshShown(token) && !_flaring.has(token.id);
      if (on && cue.visT0 == null) cue.visT0 = now;
      if (!on) cue.visT0 = null;
      const fade = cueAlpha(cue, now);
      rings.forEach((Rg, i) => { Rg.a = on ? (0.5 - i * 0.1) * fade : 0; });
      drawRings(G, R, rings, 1, dt);
    });
  }
  return cue;
}
function cueAlpha(cue, now) {
  const t0 = cue.kind === 'chainRing' ? (cue.visT0 ?? now) : cue.born + (DELAY[cue.kind] ?? 0);
  const inA = clamp((now - t0) / 260, 0, 1);
  if (!cue.exit) return inA;
  return inA * clamp(1 - (now - cue.exit.t0) / (cue.exit.ms ?? 260), 0, 1);
}
function endCue(cue, broken) {
  if (cue.exit) return;
  cue.exit = { t0: performance.now(), ms: 260 };
  if (broken && cue.kind === "chainRing" && meshShown(cue.token) && cueAlpha({ ...cue, exit: null }, performance.now()) > 0.5) {
    // the links break apart: shards along each ring, a key turn and a clank
    sfx(null, SFX.key, 0.4, 1.2); sfx(null, SFX.clank, 0.3, 1.3);
    const R = rectOf(cue.token);
    if (R) for (const Rg of cue.rings) for (let k = 0; k < 7; k++) { const a = rnd(0, Math.PI * 2), rx = (R.w * 0.62 * 0.62 + 6 * R.k) * Rg.k;
      shards(cue.H, { x: R.cx + Math.cos(a) * rx, y: R.feet - R.h * Rg.h + Math.sin(a) * rx * 0.3 }, STEEL, 1, 0.2); }
    cue.exit.ms = 380;
  }
  setTimeout(() => { cue.H.destroy(); for (const [k, c] of CUES) if (c === cue) CUES.delete(k); }, (cue.exit.ms ?? 260) + 700);
}
function refresh() {
  if (!canvas?.ready || !canvas.tokens) return;
  const want = new Map();
  if (battleActive()) for (const t of canvas.tokens.placeables) {
    if (t.destroyed || !t.actor) continue;
    for (const s of cueSpecs(t.actor)) want.set(`${t.id}|${s.kind}`, { t, s });
  }
  for (const [key, cue] of CUES) {
    if (cue.exit) continue;
    const w = want.get(key);
    if (!w || w.s.aeId !== cue.aeId) endCue(cue, battleActive() && !w);
  }
  for (const [key, { t, s }] of want) {
    const live = CUES.get(key);
    if (live && !live.exit && live.aeId === s.aeId) continue;
    if (live && !live.exit) endCue(live, false);
    CUES.set(key, makeCue(t, s));
  }
}
function clearAll() { for (const c of CUES.values()) { try { c.H.destroy(); } catch { /* */ } } CUES.clear(); }

/** Install once (every client). */
export function installSlayerFx() {
  if (_installed) return;
  _installed = true;
  const soon = foundry.utils.debounce(() => { try { refresh(); } catch (e) { warn("[slayer-fx] refresh threw", e); } }, 30);
  for (const h of ["createActiveEffect", "deleteActiveEffect", "updateActiveEffect", "createToken", "deleteToken", "fuBattleFocusChanged"]) Hooks.on(h, soon);
  Hooks.on("canvasReady", () => { clearAll(); soon(); });
  Hooks.on("canvasTearDown", () => clearAll());
  Hooks.on("fuBattleMarksHidden", (hidden) => { _hidden = !!hidden; });
  if (canvas?.ready) soon();
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.slayerFx = {
    baneApply, baneProc, giantKiller, lockdownBind, lockdownFlare, SPECIES, ELEMENT, refresh,
    cues: () => [...CUES.entries()].map(([key, c]) => ({ key, kind: c.kind, aeId: c.aeId, exit: !!c.exit, alive: c.H.alive })),
    hosts: () => (canvas.primary?.children ?? []).filter((o) => o instanceof PIXI.Graphics).length,
  };
  log("[slayer-fx] installed");
}
