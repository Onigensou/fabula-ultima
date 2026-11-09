// ════════════════════════════════════════════════════════════════════════════
// Soul Tithe on the battle HUD: the Max HP a Soul Fragment holds burns on the
// player's HP bar (the plate and every ally card).
//
// Design (approved 2026-11-09, mockup https://claude.ai/artifact/Bv2PgqZ4PSggFumPJP7j2A,
// spec docs/soul-tithe-design.md "HUD: the burned Max HP"):
//   - The bar keeps its full length (Max now + what was taken). The fill is current HP.
//     The taken part, at the right end, is charred and holds still.
//   - One narrow soul fire (4 px) burns over the bar at the split, blown right by a
//     breeze. While the split moves, the wind blows against the movement and the fire
//     leaves its licks behind it.
//   - A soot mark on the paper sits round the fire, with the fire's green light on it.
//   - Changes: a Tithe or a Calling burns the front left; a refund (fragment destroyed)
//     pushes it back right and the fire disperses into pixels that fly on with the
//     front's momentum; at the end of the fight the fire breaks into its pixels on the
//     breeze, the char turns to black ash, and the ash lifts off a flake at a time and
//     drifts away right (the user's pick "A · Ash drifts off", mockup v8, 2026-11-09).
//
// The HUD (director-player-hud.js) lazy-loads this file the first time a bar has
// anything taken, and calls syncSoulBurn(card, { v, m, stolen }, first) from its
// updateCard, BEFORE it moves the fill. Everything here is the HUD's own drawing:
// it reads nothing from the world and writes nothing to it.
//
// Two canvases per bar, both in "art pixels" (the mockup's pixel grid: the plate's
// bar is 6 art px tall, a card's 4, at any screen size):
//   - inside the bar (clipped by its rounded border): the char, its burning edge and
//     the regrow flash;
//   - over the card (the bar's offsetParent): the soot and light, the fire, the
//     sparks and the disperse.
// The model (SoulBurnModel) is plain data and runs in Node for the tests.
// ════════════════════════════════════════════════════════════════════════════

import { makeSil, makeSoulFlame, makeFlameMotion, SOUL, FH } from "./soul-fx-lib.js";
import { createFrame, clearFrame, painterFor } from "../../battle-director/pixel-entrance/pixelfx/core/index.js";
import { getClientOption } from "../../shared/client-options.js";

// ── The look (every number is the approved mockup's) ─────────────────────────
export const BURN = Object.freeze({
  FRONT_W: 4,                         // the fire's width at the split, art px
  FIRE: { k: 1.6, lift: 14, wind: 0.5 },
  UP: 14,                             // the soot's reach above the bar, art px (× the kind's scale)
  KIND: {
    plate: { s: 1, refH: 6, up: 90 }, // s: flame scale; refH: the bar's art height; up: canvas room above
    card: { s: 0.6, refH: 4, up: 60 },
  },
  TITHE_DUR: 0.5, CALL_DUR: 0.6, REST_DUR: 0.5,
  BREAK_AT: 0.9,                      // the refund's fire disperses once 90% of the way is covered
  REFUND_WAIT: 0.25,                  // a Max that comes back first waits this long for its HP
  REFUND_SEEN: 1.5,                   // an HP rise this recent counts as the refund's (HP first)
  SCORCH_K: 0.78, LIGHT_K: 0.62,      // soot and light radii, as shares of the v5 scorch size
  WIND_GAIN: 0.8, WIND_MAX: 1.5, WIND_TAU: 0.06,
  MOM_TAU: 0.35, DUST_CARRY: 0.35, DUST_MAX: 160,
  TRAIL_PAD: 74,                      // room each side of the fire for the trail it leaves
  IDLE_HZ: 30,                        // a fire that is only burning; changes use the FX rate
  // The end of the fight: the char is black ash that lifts off and drifts away (mockup v8, "A").
  // A pixel lets go REL_AT + REL_SPREAD·u + REL_RAND·random − REL_TOP·(1−v) s after the end
  // (u: 0 at the fire, 1 at the bar's end; v: 0 top row, 1 bottom), then flies as a flake.
  ASH: Object.freeze({
    ASHEN: 0.25,                      // the embers die: soul char → ash colours
    REL_AT: 0.18, REL_SPREAD: 0.5, REL_RAND: 0.45, REL_TOP: 0.06,
    VX: [12, 22], VY: [4, 11],        // flake speed: base + random span, art px/s (VY up, × the kind's scale)
    ACC: 14, GRAV: 6, FLUTTER: 1.2,   // sideways push (px/s²), fall (px/s²), flutter (px)
    LIFE: [0.8, 0.6],                 // s: base + random span
    BREEZE: 80,                       // the fire's disperse at the end: a breeze push (× DUST_CARRY) for the momentum
    MAX: 3.2,                         // fallback: a bar nobody drew (off screen) ends its ash by then
  }),
});
// ash colours (RGB): the char's three tones, then the steps a flake pales through as it flies
const ASH_TONE = { dark: [30, 29, 33], mid: [50, 48, 53], fleck: [84, 80, 86] };
const ASH_STEPS = [[96, 92, 98], [140, 135, 140], [190, 184, 182]];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
/** The split's motion: quartic ease out, fastest at the start (the user's pick). */
export const move = (u) => 1 - Math.pow(1 - clamp(u, 0, 1), 4);

// ── The model: what the bar shows, animated toward what the actor says ───────
/**
 * One bar's story. Fractions are of the full bar (Max now + taken).
 * sync() takes the actor's numbers; step(t) runs the animations; the renderer reads
 * split / k / flare / cool / breakNow / out and the event lists.
 */
export class SoulBurnModel {
  constructor() {
    this.inited = false;
    this.split = 1;          // where the Max HP still held ends
    this.splitTo = 1;        // where it is heading (a running move follows it if a later write moves it)
    this.k = 0;              // how lit the fire is (0..1)
    this.flare = 0;          // a flare on a change
    this.cool = 0;           // the end of the fight: char → empty track
    this.out = true;         // the fire went out (disperse or end)
    this.breakNow = false;   // the renderer disperses the fire this frame
    this.burnFrom = 1;       // what burned since the last char reset (for the just-burned glow)
    this.anims = [];
    this.events = [];        // { kind: "burst", at, n } | { kind: "flash", from, to } | { kind: "reset" }
    this.mode = "idle";      // the last change: init | tithe | calling | refund | end | snap
    this.prev = null;        // the last numbers seen: { v, m, stolen, full }
    this.vRoseT = -1e9;      // when the HP last went up
    this.pending = null;     // a Max that came back with no HP yet: { t, to }
    this.fillTo = 1;         // the fill's target (for the regrow flash)
    this.ash = null;         // the end of the fight: { t0 } while the char's ash blows away (the renderer ends it)
    this.ashen = 0;          // how far the char has turned to ash (0..1)
    this.breeze = false;     // the fire's disperse is pushed by the breeze, not the front's momentum
    this.now = 0;
  }

  later(t, at, dur, run) { const a = { t0: t + at, dur, run }; this.anims.push(a); return a; }
  busy() { return this.anims.length > 0 || this.pending != null; }

  /**
   * The actor's numbers moved (or were read for the first time).
   * @param {{v:number, m:number, stolen:number}} s
   * @param {number} t     clock, seconds
   * @param {boolean} first  first read for this bar: show it as it is, no animation
   */
  sync(s, t, first = false) {
    const v = Math.max(0, Number(s.v) || 0), m = Math.max(0, Number(s.m) || 0), stolen = Math.max(0, Number(s.stolen) || 0);
    const full = Math.max(1, m + stolen), to = clamp(m / full, 0, 1);
    this.fillTo = clamp(v / full, 0, 1);
    const p = this.prev;
    this.prev = { v, m, stolen, full };
    if (first || !this.inited || !p) { this.snap(to, stolen > 0, t, "init"); return "init"; }
    if (v > p.v) this.vRoseT = t;
    if (stolen > p.stolen) { this.pending = null; this.burn(to, p.stolen > 0, t); return this.mode; }
    if (stolen < p.stolen) {
      // a refund pays Max and HP in either order: HP already up → now; else wait a moment for it
      if (t - this.vRoseT <= BURN.REFUND_SEEN) { this.restore(to, t); return "refund"; }
      this.pending = { t, to };
      return "pending";
    }
    if (this.pending && v > p.v) { this.pending = null; this.restore(to, t); return "refund"; }
    if (this.pending) { this.pending.to = to; return null; }
    // same taken amount, but the target moved: a running move follows it (the AE lands before its
    // Max is re-derived); with nothing running, the full bar changed (a level up, a rewind): show it
    if (Math.abs(to - this.splitTo) > 1e-6) {
      if (this.anims.length) { this.splitTo = to; return null; }
      this.snap(to, stolen > 0, t, "snap"); return "snap";
    }
    return null;
  }

  snap(to, lit, t, mode) {
    this.inited = true;
    this.anims = []; this.pending = null; this.ash = null; this.ashen = 0; this.breeze = false;
    this.split = to; this.splitTo = to; this.k = lit ? 1 : 0; this.flare = 0; this.cool = 0; this.out = !lit; this.breakNow = false;
    this.mode = mode;
    this.events.push({ kind: "reset", t });
  }

  /** A Tithe (the fire lights at the bar's end) or a Calling (it was already burning). */
  burn(to, calling, t) {
    const from = this.split;
    this.splitTo = to;
    this.mode = calling ? "calling" : "tithe";
    this.out = false; this.cool = 0;
    if (this.ash) { this.ash = null; this.ashen = 0; this.anims = this.anims.filter((a) => !a.ash); }   // a new Tithe while ash still flies
    if (calling) this.k = 1; else this.later(t, 0, 0.12, (u) => { this.k = Math.max(this.k, u); });
    const dur = calling ? BURN.CALL_DUR : BURN.TITHE_DUR;
    this.later(t, 0, dur, (u) => { this.split = lerp(from, this.splitTo, move(u)); });
    const f0 = calling ? 1.1 : 1.4, fk = calling ? 3.5 : 3.2;
    this.later(t, 0, calling ? 1.0 : 1.2, (u) => { this.flare = Math.max(calling ? this.flare : 0, f0 * Math.exp(-u * fk)); });
  }

  /** A refund: the front is pushed back right; at the bar's end the fire disperses. */
  restore(to, t) {
    const from = this.split, whole = to >= 0.999;
    this.splitTo = to;
    this.mode = "refund";
    this.later(t, 0, BURN.REST_DUR, (u) => {
      const prev = this.split, e = move(u);
      this.split = lerp(from, this.splitTo, e);
      if (this.split > prev) this.events.push({ kind: "flash", from: prev, to: Math.min(this.split, this.fillTo), t: this.now });
      this.flare = Math.max(this.flare, 0.6 * (1 - u));
      if (whole && e >= BURN.BREAK_AT && !this.out) this.breakNow = true;
    });
    if (whole) this.later(t, BURN.REST_DUR + 0.1, 0.01, () => { this.k = 0; this.out = true; });
  }

  /**
   * The end of the fight (Max back, HP not): the fire breaks into its pixels on the breeze, the
   * char turns to black ash, and the renderer blows the ash away a flake at a time, then calls
   * ashDone(). The split holds where it was until then.
   */
  end(to, t) {
    const from = this.split;
    this.splitTo = to;
    this.mode = "end";
    if (to >= 0.999) {
      this.ash = { t0: t };
      if (this.k > 0.02) { this.breakNow = true; this.breeze = true; } else { this.k = 0; this.out = true; }
      this.later(t, 0, BURN.ASH.ASHEN, (u) => { this.ashen = Math.max(this.ashen, u); }).ash = true;
      // fallback: a bar nobody drew (off screen, a closed desk) still ends
      this.later(t, BURN.ASH.MAX, 0.01, () => { if (this.ash) this.ashDone(); }).ash = true;
    } else {
      this.later(t, 0, BURN.REST_DUR, (u) => { this.split = lerp(from, this.splitTo, move(u)); });
    }
  }

  /** The renderer dispersed the fire (or the front reached the end with the fire up). */
  dispersed() { this.breakNow = false; this.breeze = false; this.k = 0; this.out = true; }

  /** The last of the ash has gone (the renderer, or the fallback): an ordinary empty bar. */
  ashDone() {
    if (!this.ash) return;
    this.ash = null; this.ashen = 0; this.breakNow = false; this.breeze = false;
    this.anims = this.anims.filter((a) => !a.ash);
    this.split = 1; this.splitTo = 1; this.cool = 0; this.k = 0; this.out = true;
    this.events.push({ kind: "reset", t: this.now });
  }

  step(t) {
    this.now = t;
    if (this.pending && t - this.pending.t > BURN.REFUND_WAIT) { const to = this.pending.to; this.pending = null; this.end(to, t); }
    for (const a of this.anims) if (t >= a.t0) a.run(clamp((t - a.t0) / a.dur, 0, 1), t);
    this.anims = this.anims.filter((a) => t < a.t0 + a.dur);
  }
}

// ── Rendering (browser only) ─────────────────────────────────────────────────
const rgbOf = (c) => [c & 255, (c >>> 8) & 255, (c >>> 16) & 255];
const css = ([r, g, b], a = 1) => (a >= 1 ? `rgb(${r | 0},${g | 0},${b | 0})` : `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(3)})`);
const COOL = new Set([FH[7] & 0xffffff, FH[8] & 0xffffff]);   // the fire's two coolest teals read as grime on paper
const cinder = (s, x, y) => { let h = (s * 374761393 + x * 668265263 + y * 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const hashStr = (s) => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return (h % 997) + 3; };
const nowS = () => performance.now() / 1000;

// the changes redraw at the player's "Effects frame rate" (Party Menu > Config > Graphic)
let _fxHz = null;
function fxHz() {
  if (_fxHz == null) { const v = Number(getClientOption("fxFrameRate")); _fxHz = v === 30 ? 30 : 60; }
  return _fxHz;
}

class SoulBar {
  constructor(card) {
    this.card = card;
    this.bar = card.hpFill?.parentElement ?? null;
    this.kind = card.kind === "plate" ? "plate" : "card";
    this.cfg = BURN.KIND[this.kind];
    this.seed = hashStr(card.el?.dataset?.actorId ?? Math.random());
    this.model = new SoulBurnModel();
    this.motion = makeFlameMotion();
    this.flames = new Map();
    this.charT = null; this.flash = null;
    this.sparks = []; this.dust = [];
    this.ashRel = null; this.ashGone = null; this.ashLeft = 0; this.flakes = [];   // the end of the fight's ash
    this.wind = BURN.FIRE.wind; this.wSplit = 1; this.wT = -1; this.mom = 0;
    this.lastFlame = null;
    this.geom = null; this.dirty = true; this.lastDraw = -1; this.clean = true; this.lastMeasure = 0;
    this.charCv = document.createElement("canvas");
    this.charCv.className = "fu-soulburn-char";
    this.overCv = document.createElement("canvas");
    this.overCv.className = "fu-soulburn-over";
    this.restoreFillT = 0;
    this.stats = { dispersed: 0, dustMax: 0, sparksMax: 0, flakesMax: 0, ashDone: 0, frames: 0, costAvg: 0, costMax: 0 };
  }

  get alive() { return !!this.bar?.isConnected; }

  dispose() {
    this.charCv.remove(); this.overCv.remove();
    if (this.card) this.card._soulBar = null;
  }

  /** Lay the canvases on the bar's art grid. False while the bar is not on screen. */
  measure() {
    const bar = this.bar;
    if (!bar?.isConnected) return false;
    const rect = bar.getBoundingClientRect();
    if (!rect.width || !bar.offsetWidth) return false;
    if (!this.charCv.isConnected) bar.appendChild(this.charCv);
    const host = bar.offsetParent;
    if (!host) return false;
    if (this.overCv.parentElement !== host) host.appendChild(this.overCv);
    const k = (rect.width / bar.offsetWidth) * (window.devicePixelRatio || 1);
    const innerW = bar.clientWidth, innerH = bar.clientHeight;
    const art = Math.max(1, Math.round((innerH * k) / this.cfg.refH));
    const u = art / k;   // CSS px per art px
    const w = Math.max(8, Math.round(innerW / u)), h = Math.max(2, Math.round(innerH / u));
    const X0 = -44, X1 = w + 80, Y0 = -this.cfg.up, Y1 = h + 16;
    // the bar's interior in the host's coordinates (both are untransformed CSS px)
    let left = bar.clientLeft, top = bar.clientTop;
    for (let n = bar; n && n !== host; n = n.offsetParent) { left += n.offsetLeft; top += n.offsetTop; if (n.offsetParent !== host && n.offsetParent) { left += n.offsetParent.clientLeft; top += n.offsetParent.clientTop; } }
    const g = { w, h, u, X0, X1, Y0, Y1, left, top };
    const old = this.geom;
    const same = old && old.w === w && old.h === h && Math.abs(old.u - u) < 1e-6 && old.left === left && old.top === top;
    this.geom = g;
    this.dirty = false;
    if (same) return true;
    this.charCv.width = w; this.charCv.height = h;
    Object.assign(this.overCv.style, { left: `${left + X0 * u}px`, top: `${top + Y0 * u}px`, width: `${(X1 - X0) * u}px`, height: `${(Y1 - Y0) * u}px` });
    this.overCv.width = X1 - X0; this.overCv.height = Y1 - Y0;
    if (!old || old.w !== w || old.h !== h) {
      this.charT = new Float64Array(w).fill(-1e9);
      this.flash = new Float64Array(w).fill(-1e9);
      this.flames.clear();
      this.ashRel = null; this.ashGone = null;   // a running ash restarts on the new grid
      this.markChar(nowS(), true);
    }
    return true;
  }

  /** Everything from the split to the end is char (already burned, or burned long ago). */
  markChar(t, old) {
    if (!this.charT || !this.geom) return;
    const sw = Math.round(this.model.split * this.geom.w);
    for (let x = 0; x < this.geom.w; x++) this.charT[x] = x >= sw ? (old ? t - 10 : t) : -1e9;
  }

  sync(s, first) {
    const t = nowS();
    const did = this.model.sync(s, t, first);
    // a refund lands: the fill grows with the front's own ease out instead of the bar's usual ease
    if (did === "refund" && this.card.hpFill) {
      const fill = this.card.hpFill;
      fill.style.transition = `width ${Math.round(BURN.REST_DUR * 1000)}ms cubic-bezier(0.165, 0.84, 0.44, 1), background 120ms linear`;
      clearTimeout(this.restoreFillT);
      this.restoreFillT = setTimeout(() => { fill.style.transition = ""; }, BURN.REST_DUR * 1000 + 80);
    }
    wake();
  }

  /** Whether anything moves; idle bars are left alone until the next sync. */
  active() {
    const m = this.model;
    return m.k > 0.02 || m.busy() || m.cool > 0 || this.sparks.length > 0 || this.dust.length > 0 || m.breakNow
      || m.ash != null || this.flakes.length > 0;
  }

  /** The end of the fight: every char pixel gets the moment it lets go (see BURN.ASH). */
  startAsh() {
    const g = this.geom, m = this.model, A = BURN.ASH;
    const x0 = Math.round(m.split * g.w), lost = g.w - x0;
    this.ashRel = new Float64Array(g.w * g.h).fill(Infinity);
    this.ashGone = new Uint8Array(g.w * g.h);
    this.ashLeft = 0;
    for (let x = x0; x < g.w; x++) for (let y = 0; y < g.h; y++) {
      const u = lost > 1 ? (x - x0) / (lost - 1) : 0, v = g.h > 1 ? y / (g.h - 1) : 0;
      this.ashRel[y * g.w + x] = m.ash.t0 + Math.max(0.05, A.REL_AT + A.REL_SPREAD * u + A.REL_RAND * Math.random() - A.REL_TOP * (1 - v));
      this.ashLeft++;
    }
  }

  frame(t) {
    const m = this.model;
    m.step(t);
    if (this.dirty || !this.geom || t - this.lastMeasure > 1) { this.lastMeasure = t; if (!this.measure()) return; }
    const g = this.geom;
    for (const e of m.events.splice(0)) {
      if (e.kind === "reset") this.markChar(t, true);
      else if (e.kind === "burst") this.burst(e.n, e.at);
      else if (e.kind === "flash" && this.flash) {
        for (let x = Math.floor(e.from * g.w); x < Math.ceil(e.to * g.w); x++) if (x >= 0 && x < g.w) this.flash[x] = t;
      }
    }
    if (m.ash && !this.ashRel) this.startAsh();
    else if (!m.ash && this.ashRel) { this.ashRel = null; this.ashGone = null; }   // a new change took over (the flakes fly on)
    if (!this.active()) {
      if (!this.clean) { this.drawChar(t); this.overCv.getContext("2d").clearRect(0, 0, this.overCv.width, this.overCv.height); this.clean = true; }
      return;
    }
    const moving = m.anims.length > 0 || this.sparks.length > 0 || this.dust.length > 0 || m.breakNow || this.flakes.length > 0;
    const hz = moving ? fxHz() : BURN.IDLE_HZ;
    if (this.lastDraw >= 0 && t - this.lastDraw < 1 / hz - 0.002) return;
    this.lastDraw = t;
    this.clean = false;
    const c0 = performance.now();
    this.drawChar(t);
    this.drawOver(t);
    // the last of the ash has gone
    if (this.ashRel && this.ashLeft <= 0 && !this.flakes.length) { this.ashRel = null; this.ashGone = null; m.ashDone(); this.stats.ashDone++; }
    const st = this.stats, ms = performance.now() - c0;
    st.frames++; st.costAvg += (ms - st.costAvg) / Math.min(st.frames, 120); st.costMax = Math.max(st.costMax, ms);
    st.dustMax = Math.max(st.dustMax, this.dust.length); st.sparksMax = Math.max(st.sparksMax, this.sparks.length); st.flakesMax = Math.max(st.flakesMax, this.flakes.length);
  }

  /** The taken part: char with a burning edge, the just-burned glow, the regrow flash. */
  drawChar(t) {
    const g = this.geom, m = this.model, cv = this.charCv;
    if (!g || !this.charT) return;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(g.w, g.h), d = new Uint32Array(img.data.buffer);
    const splitW = Math.round(m.split * g.w), lost = g.w - splitW;
    for (let x = splitW; x < g.w; x++) if (this.charT[x] < -1e8) this.charT[x] = t;
    for (let x = 0; x < splitW; x++) this.charT[x] = -1e9;
    const edgeW = g.h >= 6 ? 2 : 1, ash = this.ashRel, A = BURN.ASH;
    for (let x = 0; x < lost; x++) {
      const age = t - this.charT[splitW + x];
      for (let y = 0; y < g.h; y++) {
        let c;
        if (x < edgeW && m.k > 0.3) c = SOUL[5];
        else if (x < edgeW + 1 && m.k > 0.3) c = SOUL[3];
        else if (age < 0.12) c = SOUL[5];
        else if (age < 0.26) c = SOUL[4];
        else if (age < 0.45) c = SOUL[3];
        else { const h = cinder(this.seed, splitW + x, y); c = h > 0.9 && y > 0 ? SOUL[3] : h > 0.62 ? SOUL[1] : SOUL[0]; }
        if (ash) {
          // the end of the fight: black ash; each pixel lets go at its moment and flies off as a flake
          const q = y * g.w + splitW + x;
          if (this.ashGone[q]) continue;   // gone: the bar's own empty track shows
          const h = cinder(this.seed, splitW + x, y), tone = h > 0.9 && y > 0 ? ASH_TONE.fleck : h > 0.62 ? ASH_TONE.mid : ASH_TONE.dark;
          const rgb = rgbOf(c).map((v, j) => Math.round(lerp(v, tone[j], m.ashen)));
          if (t >= ash[q]) {
            this.ashGone[q] = 1; this.ashLeft--;
            this.flakes.push({ x: splitW + x, y, c: rgb, t0: t, ph: Math.random() * 6.283,
              vx: A.VX[0] + Math.random() * A.VX[1], vy: -(A.VY[0] + Math.random() * A.VY[1]) * this.cfg.s, life: A.LIFE[0] + Math.random() * A.LIFE[1] });
            continue;
          }
          c = (rgb[2] << 16) | (rgb[1] << 8) | rgb[0];
        }
        // cooling at the end of the fight: the char fades and the bar's own empty track shows through
        const a = Math.round(255 * (1 - m.cool));
        d[y * g.w + splitW + x] = ((a << 24) | (c & 0xffffff)) >>> 0;
      }
    }
    // the regrow flash: fresh green glows soul-pale for a moment
    for (let x = 0; x < splitW; x++) {
      const a = t - this.flash[x];
      if (a >= 0.18) continue;
      const al = Math.round(255 * 0.9 * (1 - a / 0.18));
      for (let y = 0; y < g.h; y++) d[y * g.w + x] = ((al << 24) | (186 << 16) | (255 << 8) | 180) >>> 0;
    }
    ctx.putImageData(img, 0, 0);
  }

  flameFor(w) {
    let f = this.flames.get(w);
    if (f) return f;
    const g = this.geom, s = this.cfg.s;
    const sil = makeSil({ x: 0, y: 0, w, h: g.h, mask: new Uint8Array(w * g.h).fill(1) });
    const fl = makeSoulFlame(sil, {
      motion: this.motion, trailPad: BURN.TRAIL_PAD, gpuGlow: true, smoke: false, cover: true,
      wind: BURN.FIRE.wind, k: BURN.FIRE.k * (0.5 + 0.5 * s), lift: BURN.FIRE.lift * s, seed: this.seed,
    });
    const x0 = -BURN.TRAIL_PAD, fw = w + 2 * BURN.TRAIL_PAD, fh = g.Y1 - g.Y0;
    const frame = createFrame(fw, fh, x0, g.Y0);
    const c = document.createElement("canvas"); c.width = fw; c.height = fh;
    f = { fl, frame, c, x0, img: new ImageData(new Uint8ClampedArray(frame.color.buffer), fw, fh) };
    this.flames.set(w, f);
    return f;
  }

  drawOver(t) {
    const g = this.geom, m = this.model, cfg = this.cfg;
    const ctx = this.overCv.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overCv.width, this.overCv.height);
    ctx.setTransform(1, 0, 0, 1, -g.X0, -g.Y0);   // draw in bar art px from here on
    ctx.imageSmoothingEnabled = false;

    // the wind: the breeze, pushed against the way the split moves; the front's momentum
    if (this.wT >= 0 && t > this.wT) {
      const dt = t - this.wT, v = (m.split - this.wSplit) / dt;
      const target = clamp(BURN.FIRE.wind - v * BURN.WIND_GAIN, -BURN.WIND_MAX, BURN.WIND_MAX);
      this.wind += (target - this.wind) * (1 - Math.exp(-dt / BURN.WIND_TAU));
      const vpx = v * g.w;
      this.mom = Math.abs(vpx) > Math.abs(this.mom) ? vpx : this.mom * Math.exp(-dt / BURN.MOM_TAU);
    }
    this.wT = t; this.wSplit = m.split;

    const prevFlame = this.lastFlame; this.lastFlame = null;
    const splitW = Math.round(m.split * g.w), lost = g.w - splitW;
    if (lost > 0 && m.k > 0.01) {
      // the soot on the paper, and the fire's light caught on it
      const up = Math.round(BURN.UP * cfg.s) + 4, sw = Math.min(lost, BURN.FRONT_W), cx = splitW + sw / 2, cy = g.h / 2;
      const rx0 = Math.max(sw / 2 + 6, up + 4), squash = (up + 6) / rx0, a = m.k;
      const rx = rx0 * BURN.SCORCH_K, sg = ctx.createRadialGradient(cx, cy, 1, cx, cy, rx);
      sg.addColorStop(0, `rgba(28,34,22,${(0.42 * a).toFixed(3)})`); sg.addColorStop(0.6, `rgba(40,38,26,${(0.22 * a).toFixed(3)})`); sg.addColorStop(1, "rgba(60,48,30,0)");
      ctx.save(); ctx.translate(cx, cy); ctx.scale(1, squash); ctx.translate(-cx, -cy); ctx.fillStyle = sg; ctx.fillRect(cx - rx, cy - rx, rx * 2, rx * 2); ctx.restore();
      const fl = (0.78 + 0.12 * Math.sin(t * 23 + this.seed) + 0.1 * Math.sin(t * 7.3 + this.seed * 2)) * a * (1 + 0.6 * m.flare);
      const gx = cx + clamp(this.wind, -1.5, 1.5) * 3 * cfg.s, gy = cy - up * 0.15, gr = rx0 * BURN.LIGHT_K, L = rgbOf(SOUL[5]);
      const lg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
      lg.addColorStop(0, css(L, Math.min(1, fl))); lg.addColorStop(0.35, css(L, Math.min(1, 0.78 * fl))); lg.addColorStop(0.7, css(L, Math.min(1, 0.32 * fl))); lg.addColorStop(1, css(L, 0));
      ctx.save(); ctx.translate(gx, gy); ctx.scale(1, squash); ctx.translate(-gx, -gy); ctx.fillStyle = lg; ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2); ctx.restore();

      // the burning front, over the bar
      const f = this.flameFor(Math.min(lost, BURN.FRONT_W)), p = painterFor(clearFrame(f.frame));
      f.fl.setWind(this.wind, t); f.fl.setOrigin(splitW, t);
      f.fl.drawBack(p, t, () => 0, m.k, m.flare);
      f.fl.draw(p, t, () => 0, m.k, m.flare, 1);
      const buf = f.frame.color;
      for (let q = 0; q < buf.length; q++) { const c = buf[q]; if (c && ((c >>> 24) < 160 || COOL.has(c & 0xffffff))) buf[q] = 0; }
      const last = { f, x: splitW + f.x0, y: g.Y0 };
      if (m.breakNow) { this.disperse(last, t); this.burst(4, m.split); m.dispersed(); }
      else {
        f.c.getContext("2d").putImageData(f.img, 0, 0);
        ctx.drawImage(f.c, last.x, last.y);
        this.lastFlame = last;
      }
    } else if (lost <= 0 && prevFlame && m.k > 0.02) {
      // the front reached the end with the fire still up: it disperses from its last frame
      this.disperse(prevFlame, t); this.burst(4, 1); m.dispersed();
    }

    // the disperse: the fire's own pixels fly on with the front's momentum and cool away
    this.dust = this.dust.filter((q) => t - q.t0 < q.life);
    for (const q of this.dust) {
      const a = t - q.t0, f = a / q.life;
      const x = Math.round(q.x + (q.vx * (1 - Math.exp(-2.2 * a))) / 2.2), y = Math.round(q.y + q.vy * a - 22 * a * a);
      ctx.fillStyle = css(rgbOf(f < 0.2 ? q.c : f < 0.45 ? SOUL[4] : f < 0.7 ? SOUL[3] : SOUL[2]));
      ctx.fillRect(x, y, 1, 1);
    }
    // ash flakes (the end of the fight): carried right by the breeze, fluttering, paling in steps until gone
    const A = BURN.ASH;
    this.flakes = this.flakes.filter((q) => t - q.t0 < q.life);
    for (const q of this.flakes) {
      const a = t - q.t0, f = a / q.life;
      const x = Math.round(q.x + q.vx * a + 0.5 * A.ACC * a * a + Math.sin(q.ph + a * 5) * A.FLUTTER * 0.6);
      const y = Math.round(q.y + q.vy * a + 0.5 * A.GRAV * a * a + Math.sin(q.ph + a * 8) * A.FLUTTER);
      ctx.fillStyle = css(f < 0.35 ? q.c : f < 0.6 ? ASH_STEPS[0] : f < 0.85 ? ASH_STEPS[1] : ASH_STEPS[2]);
      ctx.fillRect(x, y, 1, 1);
    }
    // sparks, carried right by the breeze
    this.sparks = this.sparks.filter((s) => t - s.t0 < s.life);
    for (const s of this.sparks) {
      const a = (t - s.t0) / s.life, dt = t - s.t0, z = g.h >= 6 ? 2 : 1;
      ctx.fillStyle = css(rgbOf(a < 0.3 ? SOUL[6] : a < 0.65 ? SOUL[5] : SOUL[4]));
      ctx.fillRect(Math.round(s.x + s.vx * dt), Math.round(s.y + s.vy * dt + 18 * dt * dt), z, z);
    }
  }

  burst(n, at) {
    const g = this.geom;
    if (!g) return;
    const x0 = Math.round(at * g.w), t = nowS();
    for (let j = 0; j < n; j++) this.sparks.push({ x: x0 + (Math.random() - 0.5) * 4, y: Math.random() * g.h, vx: 8 + Math.random() * 22, vy: -(12 + Math.random() * 26) * this.cfg.s, t0: t, life: 0.5 + Math.random() * 0.4 });
  }

  /** The fire's frame breaks into its own pixels, all moving at once; the top flies a little faster. */
  disperse(last, t) {
    const { f, x: ox, y: oy } = last, d = f.frame.color, w = f.frame.w, h = f.frame.h;
    const pts = [];
    let minY = 1e9, maxY = -1e9, sx = 0, sy = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const c = d[j * w + i];
      if (!c) continue;
      const x = ox + i, y = oy + j;
      pts.push([x, y, c]); sx += x; sy += y; minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (!pts.length) return;
    this.stats.dispersed++;
    const cx = sx / pts.length, cy = sy / pts.length, span = Math.max(1, maxY - minY);
    // the front's momentum; at the end of the fight (nothing moving) the breeze pushes instead
    const carry = clamp((this.model.breeze ? BURN.ASH.BREEZE : this.mom) * BURN.DUST_CARRY, -BURN.DUST_MAX, BURN.DUST_MAX);
    for (const [x, y, c] of pts) {
      const up = 1 - (y - minY) / span;
      this.dust.push({ x, y, c, t0: t, vx: carry * (0.6 + 0.6 * Math.random() + 0.3 * up) + (x - cx) * 1.2 + (Math.random() - 0.5) * 10, vy: -(8 + Math.random() * 20) * this.cfg.s + (y - cy) * 0.6, life: 0.35 + Math.random() * 0.4 });
    }
  }
}

// ── The loop: one rAF for every bar, asleep when nothing burns ───────────────
const bars = new Set();
let raf = 0;
function wake() { if (!raf && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick); }
function tick() {
  raf = 0;
  const t = nowS();
  let any = false;
  for (const b of bars) {
    if (!b.alive) { b.dispose(); bars.delete(b); continue; }
    try { b.frame(t); } catch (e) { console.warn("[SoulBurn] frame threw", e); b.dispose(); bars.delete(b); continue; }
    if (b.active() || !b.clean) any = true;
  }
  if (any) wake();
}

let styled = false;
function ensureStyle() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const st = document.createElement("style");
  st.id = "fu-soulburn-style";
  st.textContent = `
.fu-soulburn-char { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; image-rendering: pixelated; }
.fu-soulburn-over { position: absolute; z-index: 4; pointer-events: none; image-rendering: pixelated; }`;
  document.head.appendChild(st);
  window.addEventListener("resize", () => { for (const b of bars) b.dirty = true; wake(); });
  try { Hooks.on("fuClientOptionChanged", ({ key, value } = {}) => { if (key === "fxFrameRate") _fxHz = Number(value) === 30 ? 30 : 60; }); } catch { /* no Hooks (tests) */ }
}

/**
 * The HUD's entry point: a bar's HP numbers were (re)read.
 * @param {object} card   the HUD's card handle (needs el, kind, hpFill)
 * @param {{v:number, m:number, stolen:number}} s  current HP, Max now, Max taken by the Soul Tithe
 * @param {boolean} first  the first read of this card: show it as it is
 */
export function syncSoulBurn(card, s, first = false) {
  if (!card?.hpFill?.parentElement) return;
  ensureStyle();
  let b = card._soulBar;
  if (!b) {
    if (!(s.stolen > 0)) return;   // nothing taken and nothing burning: no canvases at all
    b = card._soulBar = new SoulBar(card);
    bars.add(b);
    // made by a change (not a first read): before it, nothing was taken and the bar was whole
    if (!first) b.model.sync({ v: s.v, m: s.m + s.stolen, stolen: 0 }, nowS(), true);
  }
  b.sync(s, first);
}

/** Rig/debug view of every live bar. */
export function soulBurnStatus() {
  return [...bars].map((b) => ({
    actorId: b.card.el?.dataset?.actorId, kind: b.kind, mode: b.model.mode, split: b.model.split, k: b.model.k,
    cool: b.model.cool, out: b.model.out, busy: b.model.busy(), dust: b.dust.length, sparks: b.sparks.length,
    ash: !!b.model.ash, ashen: b.model.ashen, ashLeft: b.ashRel ? b.ashLeft : 0, flakes: b.flakes.length,
    wind: b.wind, mom: b.mom, geom: b.geom && { w: b.geom.w, h: b.geom.h, u: b.geom.u }, stats: { ...b.stats },
  }));
}
