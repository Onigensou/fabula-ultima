// ============================================================================
// Nidhogg's battle opening — beats 1-2, the CRACK-OUT (every client), called through the battle opening's crackOut
// seam (nidhogg-awakening-show.js registers it; battle-opening.js crackOutRunner runs it; the shatter hands it ctx).
//
// The contract (battle-transition/shatter-transition.js CRACK_OUT_CONTRACT):
//   nidhoggCrackOut(ctx) -> Promise, called on EVERY client where the shatter's glass would break, with the cracked
//   frame still up. Draw into ctx.layer (a full-window <div> above the frozen frame + its cracks); the cracks are
//   ctx.strokes / ctx.cracks (CSS px) and ctx.impact. RESOLVE when the screen is fully black and the eyes are gone:
//   the opening's black cover goes up at that moment, the shatter overlay is removed, and the show's clock starts
//   (nidhogg-awakening.js: the claw shot 4 s later). CRACK_OUT_MS = how long it takes (the GM's bound and what a
//   client that cannot play it waits). Stop drawing once ctx.torn() is true.
//
// Two beats on ONE clock and ONE painter (crystal-worker.js "crackout", lane LEAK_LANE: a Worker of its own, made for
// the crack-out and gone when it is dropped at the end of the seam, so the crystal / fall / return painters never
// share its frame budget). Both are the mockup v3, ported 1:1 (2026-11-20): crack-out-painter.js + crack-out-leak.js +
// crack-out-eyes.js paint, this thread only puts the frames into <canvas>es (CSS-scaled, pixelated).
//   beat 1 crackOutLeak(ctx)  black smoke leaks out of 5 points along the cracks until the screen is black (3.6 s).
//                             Leaves an opaque black plate in ctx.layer.
//   beat 2 crackOutEyes(ctx)  1.0 s after black, both his eyes open in the black, hold, and draw back into the dark
//                             (3.55 s). Two canvases ABOVE the black plate: the colour, and the light with
//                             mix-blend-mode plus-lighter (the mockup's globalCompositeOperation "lighter").
// ============================================================================

import { warn, log } from "../battle-director/logger.js";
import { getClientOption } from "../shared/client-options.js";
import { channel, channelMode } from "./crystal-host-lib.js";
import {
  crackOutPlan, crackOutPhase, paintsAt, eyesAt, effectGrid, strokesFromCracks, leakBands, LEAK_WARM_TS,
  EYES_MS, LEAK_MS, CRACK_OUT_MS, READY_WAIT_MS, FALLBACK_FADE_MS,
} from "./crack-out-painter.js";

export { CRACK_OUT_MS, LEAK_MS, EYES_MS };
/**
 * The painters' lanes (crystal-host-lib channel): extra Workers made for the crack-out, each gone when its painter is
 * dropped. The leak is painted in two horizontal BANDS (crack-out-painter.js leakBands), one painter per lane, both on
 * the same clock and joined in one canvas (a frame shows once both bands of it are in): LEAK_LANE paints the top band
 * and, in beat 2, the eyes; LEAK_LANE + 1 the bottom band, dropped when the leak is over (2026-11-20: one painter for
 * the whole frame ran p95 13.5-15.7 ms on the real GPU's Worker and missed 18-37 of ~226 frames).
 */
export const LEAK_LANE = 3;

const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
function el(tag, style) { const e = document.createElement(tag); Object.assign(e.style, style); return e; }
const summary = (arr) => {
  const v = arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b), n = v.length;
  return n ? { n, avg: +(v.reduce((s, x) => s + x, 0) / n).toFixed(2), p95: +v[Math.min(n - 1, Math.floor(n * 0.95))].toFixed(2), max: +v[n - 1].toFixed(2) } : null;
};
const union = (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
/** The light's blend: plus-lighter (= canvas "lighter"); screen where a browser lacks it (close for faint light). */
const lighter = () => { try { return globalThis.CSS?.supports?.("mix-blend-mode", "plus-lighter") ? "plus-lighter" : "screen"; } catch { return "screen"; } };

let _uid = 0;
let _last = null;          // the last crack-out's stats on this client (__FU_CRACK_OUT__.last())

/* ── The host: one painter, one clock, both beats ─────────────────────────── */

class CrackOutHost {
  constructor(ctx, stats) {
    this.ctx = ctx; this.stats = stats;
    // the timeline (ms from the call, first time each): stats.tl, so a rig can line a frame hitch up against it
    this.tCall = performance.now();
    stats.tCallPerf = this.tCall; stats.tl = {};
    this.S = Math.max(0.1, Number(ctx.speed) || 1);
    this.P = crackOutPlan();
    const W = Number(ctx.W) || window.innerWidth, H = Number(ctx.H) || window.innerHeight;
    this.grid = effectGrid(W, H);
    // the leak's frame, scaled up by CSS (pixelated: no smoothing, as the mockup's drawImage with smoothing off)
    this.cv = this.#canvas();
    this.g = this.cv.getContext("2d");
    // the black once the leak is over (the mockup stops drawing the frozen frame there)
    this.black = el("div", { position: "absolute", inset: "0", background: "#000", opacity: "0", pointerEvents: "none" });
    ctx.layer.append(this.cv, this.black);
    this.mark("canvas");
    this.id = `crackout:${++_uid}`;
    // the painters: one a band (part 0 also paints the eyes), each on its own lane
    // (A/B: globalThis.__FU_CRACK_OUT_ONE_PAINTER__ = true paints the leak whole on one painter, as before the bands)
    this.bands = leakBands(this.grid.EH, globalThis.__FU_CRACK_OUT_ONE_PAINTER__ === true ? [] : undefined);
    stats.laneBefore = this.bands.map((_, i) => channelMode(LEAK_LANE + i)).join("/");
    this.parts = this.bands.map((band, i) => ({ i, lane: LEAK_LANE + i, band, ch: channel(LEAK_LANE + i), id: `${this.id}:${i}`, ready: false, spare: null, lastRect: null, got: null, dropped: false, ms: [] }));
    this.ch = this.parts[0].ch;
    this.mark("channel");
    this.fxHz = Number(getClientOption("fxFrameRate")) === 30 ? 30 : 60;
    this.beat = 1;             // which beat asks for frames
    this.ready = false; this.inflight = false; this.missed = false; this.seq = 0; this.askBeat = 0; this.askParts = []; this.nextDue = -Infinity;
    this.spareL = null; this.lastRect = null; this.lastRectL = null;
    this.over = false;         // beat 1 over (the black plate up)
    this.eyesUp = false; this.eyesOver = false; this.closed = false; this.t0 = null;
    this.B = { 1: { workerMs: [], putMs: [], rafMs: [], frames: 0, missed: 0 }, 2: { workerMs: [], putMs: [], rafMs: [], frames: 0, missed: 0 } };
    this.lastRaf = null;
    stats.grid = this.grid; stats.fxHz = this.fxHz; stats.lane = LEAK_LANE; stats.lanes = this.parts.map((q) => q.lane); stats.bands = this.bands;
  }

  #canvas(style = {}) {
    const { PX, EW, EH } = this.grid;
    const c = el("canvas", { position: "absolute", left: "0", top: "0", width: `${EW * PX}px`, height: `${EH * PX}px`, imageRendering: "pixelated", pointerEvents: "none", ...style });
    c.width = EW; c.height = EH;
    return c;
  }

  /** The first time `name` happened (ms from the call) into stats.tl. */
  mark(name, now = performance.now()) { if (this.stats.tl && this.stats.tl[name] == null) this.stats.tl[name] = +(now - this.tCall).toFixed(1); }

  /** s into the crack-out (speed 1) at performance time `now`. */
  T(now = performance.now()) { return this.t0 == null ? 0 : (now - this.t0) / (1000 * this.S); }

  /** The painters' inputs (the same for every band but its rows). */
  #crackOutInit() {
    if (this.initMsg) return this.initMsg;
    const c = this.ctx, { PX } = this.grid;
    const strokes = Array.isArray(c.strokes) && c.strokes.length ? c.strokes : strokesFromCracks(c.cracks ?? []);
    this.stats.strokes = Array.isArray(c.strokes) && c.strokes.length ? "ctx.strokes" : "rebuilt from ctx.cracks";
    const W = Number(c.W) || window.innerWidth, H = Number(c.H) || window.innerHeight;
    return (this.initMsg = { PX, strokes: strokes.map((s) => ({ kind: s.kind, pts: s.pts.map((p) => ({ x: p.x, y: p.y })), width: [...s.width] })), impact: { x: c.impact?.x ?? W * 0.47, y: c.impact?.y ?? H * 0.5 }, U: Math.min(W, H) });
  }

  #initPainter(part) {
    const { EW, EH } = this.grid;
    part.ready = false; part.got = null; part.spare = null;
    part.ch.init(part.id, { W: EW, H: EH }, undefined, (m) => this.#onMessage(part, m), {
      painter: "crackout",
      crackOut: { ...this.#crackOutInit(), band: part.band, eyes: part.i === 0, warm: LEAK_WARM_TS },
    });
    this.mark("initSent");
  }

  /** The parts a frame of beat `beat` is painted by: every live band in beat 1, part 0 (the eyes) in beat 2. */
  #partsFor(beat) { return beat === 1 ? this.parts.filter((q) => !q.dropped) : [this.parts[0]]; }

  #onMessage(part, m) {
    if (this.closed || part.dropped) return;
    if (m.type === "ready") {
      part.ready = true;
      const now = performance.now();
      if (m.warmMs) (this.stats.warmMs ??= [])[part.i] = +m.warmMs.toFixed(1);
      this.mark(`ready${part.i}`, now);
      if (!this.#partsFor(this.beat).every((q) => q.ready)) return;
      this.ready = true;
      this.mark("ready", now);
      if (this.stats.readyMs == null) { this.stats.readyMs = +(now - this.tCall).toFixed(1); this.stats.mode = this.parts.map((q) => channelMode(q.lane)).join("/"); }
      if (this.t0 == null && this.beat === 1 && !this.gaveUp) {
        // the clock: T 0 at the call, unless the painter came later than the first leak; then the hold runs on
        // (the cracked frame, its glow breathing) and the leak opens the moment the painter is there
        const lead = this.P.leak * 1000 * this.S;
        this.t0 = now - this.tCall > lead ? now - lead : this.tCall;
        this.stats.tl.leakOpens = +(this.t0 + lead - this.tCall).toFixed(1);
        this.onReady?.();
      }
      return;
    }
    if (m.type === "restart") {
      this.ready = false; this.#cancelAsk(); if (part.i === 0) this.spareL = null;
      this.stats.restarts = (this.stats.restarts ?? 0) + 1; this.#initPainter(part); return;
    }
    if (m.type === "error") { this.#cancelAsk(); this.stats.errors = (this.stats.errors ?? 0) + 1; return; }
    if (m.type !== "frame") return;
    const light = m.light?.byteLength ? m.light : null;
    if (m.seq !== this.seq || !this.askParts.includes(part)) { part.spare = m.color?.byteLength ? m.color : part.spare; if (light) this.spareL = light; return; }
    part.got = m;
    // a leak frame shows once every band of it is in (the same seq, so the same T)
    if (!this.askParts.every((q) => q.got)) return;
    const got = this.askParts.map((q) => q.got);
    this.inflight = false;
    const beat = this.askBeat, B = this.B[beat];
    this.mark(`frame${beat}`);
    // a leak frame that lands after the leak is over (or an eye frame after the eyes): its buffers back, nothing shown
    const stale = beat !== this.beat || (beat === 1 && this.over) || (beat === 2 && !this.eyesUp);
    if (!stale) {
      const a = performance.now();
      try {
        const { EW, EH } = this.grid;
        if (beat === 1) {
          // each band into its rows of the one canvas, through the union of its last and new box (whole-frame rows)
          for (const q of this.askParts) {
            const f = q.got, y0 = q.band[0], bh = q.band[1] - q.band[0], r = union(q.lastRect, f.cRect);
            if (r && f.color?.byteLength === EW * bh * 4) this.g.putImageData(new ImageData(new Uint8ClampedArray(f.color), EW, bh), 0, y0, r[0], r[1] - y0, r[2] - r[0] + 1, r[3] - r[1] + 1);
            q.lastRect = f.cRect;
          }
        } else {
          // the eyes: colour and light, each into its own canvas, each through the union of its last and new box
          const r = union(this.lastRect, m.cRect), rl = union(this.lastRectL, m.lRect);
          if (r && m.color?.byteLength) this.eg.putImageData(new ImageData(new Uint8ClampedArray(m.color), EW, EH), 0, 0, r[0], r[1], r[2] - r[0] + 1, r[3] - r[1] + 1);
          if (rl && light) this.lg.putImageData(new ImageData(new Uint8ClampedArray(light), EW, EH), 0, 0, rl[0], rl[1], rl[2] - rl[0] + 1, rl[3] - rl[1] + 1);
          this.lastRect = m.cRect; this.lastRectL = light ? m.lRect : this.lastRectL;
        }
      } catch (e) { warn("nidhogg-crack-out: frame put failed", e); }
      const b = performance.now();
      B.putMs.push(b - a);
      this.mark(`put${beat}`, b);
      if (b - a > 4 && (this.stats.slowPuts ??= []).length < 20) this.stats.slowPuts.push({ at: +(a - this.tCall).toFixed(1), beat, ms: +(b - a).toFixed(1) });
      // the frame's Worker cost: its slowest band
      B.workerMs.push(Math.max(...got.map((f) => f.ms)));
      if (beat === 1) {
        this.askParts.forEach((q) => q.ms.push(q.got.ms));
        // the leak's frames: [T, ask to shown (ms), each band's Worker ms] (a rig reads where the slow ones are)
        (this.stats.trace ??= []).push([+this.askT.toFixed(3), +(b - this.askAt).toFixed(1), ...got.map((f) => +f.ms.toFixed(1))]);
      }
      B.frames++;
    }
    for (const q of this.askParts) { q.spare = q.got.color?.byteLength ? q.got.color : null; q.got = null; }
    if (light) this.spareL = light;
    // a tick went by while it was painted: the next one now (as nidhogg-fall-show.js Layer)
    if (this.missed) { this.missed = false; this.#ask(performance.now(), true); }
  }

  /** Ask for the frame at now (one in flight), once every 1 / fxHz s (crystal-death-show.js #ask). */
  #ask(now, late = false) {
    if (!this.ready || this.closed || this.t0 == null) return;
    const T = this.T(now), beat = this.beat;
    if (beat === 1 ? (this.over || !paintsAt(T, this.P)) : (!this.eyesUp || !eyesAt(T, this.P))) return;
    const period = 1000 / this.fxHz, slack = Math.min(4, period / 4);
    if (!late && now + slack < this.nextDue) return;
    if (this.inflight) { this.missed = true; this.B[beat].missed++; return; }
    const parts = this.#partsFor(beat);
    if (!parts.length || !parts.every((q) => q.ready)) return;
    this.nextDue = Math.max(this.nextDue + period, now + period - slack);
    this.inflight = true;
    const seq = ++this.seq, bufL = beat === 2 ? this.spareL : null;
    if (bufL) this.spareL = null;
    this.askBeat = beat; this.askParts = parts; this.askAt = now; this.askT = T;
    this.mark(`ask${beat}`, now);
    for (const q of parts) {
      const buf = q.spare;
      q.spare = null; q.got = null;
      q.ch.draw(q.id, seq, now / 1000, { T }, buf, q.i === 0 ? bufL : null);
    }
  }

  /** Nothing in flight any more: a frame asked for before now lands as spare buffers (its seq is gone). */
  #cancelAsk() {
    this.seq++; this.inflight = false;
    for (const q of this.askParts) { if (q.got?.color?.byteLength) q.spare = q.got.color; q.got = null; }
    this.askParts = [];
  }

  #tick = () => {
    if (this.closed) return;
    const now = performance.now();
    if (this.lastRaf != null && this.t0 != null) {
      const ph = crackOutPhase(this.T(now), this.P);
      if (ph === "leak" && this.beat === 1 && !this.over) this.B[1].rafMs.push(now - this.lastRaf);
      else if (ph === "eyes" && this.eyesUp) this.B[2].rafMs.push(now - this.lastRaf);
    }
    this.lastRaf = now;
    if (this.ctx.torn?.()) { this.endLeak(); return; }   // the beats' timers see it too and end; the seam closes
    this.#ask(now);
    this.raf = requestAnimationFrame(this.#tick);
  };

  /** Beat 1 -> Promise: resolves once the screen is black (the black plate up). The painter stays for beat 2. */
  async leak() {
    this.raf = requestAnimationFrame(this.#tick);
    const readyP = new Promise((r) => { this.onReady = r; });
    for (const q of this.parts) this.#initPainter(q);
    const got = await Promise.race([readyP.then(() => true), wait(READY_WAIT_MS * this.S).then(() => false)]);
    if (!got || this.ctx.torn?.()) {
      if (!got) {
        this.gaveUp = true;
        warn(`nidhogg-crack-out: the leak's painters were not ready in ${READY_WAIT_MS} ms (${this.parts.map((q) => `${channelMode(q.lane)}${q.ready ? " ready" : ""}`).join(", ")}): a plain fade to black`);
        this.stats.fallback = true;
        try { this.black.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FALLBACK_FADE_MS * this.S, easing: "cubic-bezier(.55,0,.75,.4)", fill: "forwards" }); } catch { /* below */ }
        await wait(FALLBACK_FADE_MS * this.S);
      }
      this.endLeak();
      return;
    }
    // to the black on a timer, so a hidden window (no rAF) still ends on time
    while (!this.over) {
      const left = this.t0 + this.P.allBlack * 1000 * this.S - performance.now();
      if (left <= 0 || this.ctx.torn?.()) break;
      await wait(Math.min(left, 250));
    }
    this.endLeak();
  }

  /** Beat 1 over: the black plate up, the leak's canvas gone (the painter stays). Idempotent. */
  endLeak() {
    if (this.over) return;
    this.over = true;
    this.black.getAnimations?.().forEach((a) => a.cancel());
    this.black.style.opacity = "1";
    try { this.cv.remove(); } catch { /* gone */ }
    this.mark("plate");
    // a leak frame still in flight is not shown; the bands but the eyes' painter are dropped (their Workers end)
    this.#cancelAsk();
    for (const q of this.parts.slice(1)) this.#dropPart(q);
    const B = this.B[1];
    Object.assign(this.stats, {
      leakS: this.t0 == null ? null : +this.T().toFixed(3),
      worker: summary(B.workerMs), put: summary(B.putMs), raf: summary(B.rafMs), frames: B.frames, missed: B.missed,
      bandWorker: this.parts.map((q) => summary(q.ms)),
    });
  }

  /**
   * Beat 2 -> Promise: from the black plate, the eyes on the same clock (eyes = black + 1.0 s), resolving at dark
   * (eyes + EYES_DARK) on a timer. After a fallback fade (no painter in time) the clock is set so that beat 1 ended
   * at allBlack, and the eyes show if the painter turns up by then.
   */
  async eyes() {
    if (this.closed) return;
    this.beat = 2;
    this.lastRect = null;
    if (this.t0 == null) { this.t0 = performance.now() - this.P.allBlack * 1000 * this.S; this.stats.eyesClock = "after the fallback"; }
    // above the black plate (appended after it): the colour, then the light added over it
    const blend = lighter();
    this.ec = this.#canvas(); this.lc = this.#canvas({ mixBlendMode: blend });
    this.eg = this.ec.getContext("2d"); this.lg = this.lc.getContext("2d");
    this.ctx.layer.append(this.ec, this.lc);
    this.mark("eyesCanvas");
    this.eyesUp = true;
    this.stats.lightBlend = blend;
    while (!this.closed) {
      const left = this.t0 + this.P.dark * 1000 * this.S - performance.now();
      if (left <= 0 || this.ctx.torn?.()) break;
      await wait(Math.min(left, 250));
    }
    this.endEyes();
  }

  /** Beat 2 over: the eye canvases gone (the screen is the black plate). Idempotent. */
  endEyes() {
    if (this.eyesOver || this.beat !== 2) return;
    this.eyesOver = true; this.eyesUp = false;
    this.mark("eyesEnd");
    for (const c of [this.ec, this.lc]) { try { c?.remove(); } catch { /* gone */ } }
    const B = this.B[2];
    this.stats.eyesS = +this.T().toFixed(3);
    this.stats.eyes = { worker: summary(B.workerMs), put: summary(B.putMs), raf: summary(B.rafMs), frames: B.frames, missed: B.missed };
  }

  /** The seam is over: everything drawn ends (the black plate stays), the painter is dropped. Idempotent. */
  close() {
    if (this.closed) return;
    this.endLeak();
    this.endEyes();
    this.closed = true;
    this.mark("close");
    cancelAnimationFrame(this.raf);
    for (const q of this.parts) this.#dropPart(q);
  }

  #dropPart(q) {
    if (q.dropped) return;
    q.dropped = true; q.ready = false; q.got = null; q.spare = null;
    try { q.ch.drop(q.id); } catch { /* gone */ }
  }
}

/**
 * Beat 1 (see the header). Resolves with the screen black: an opaque black <div> left in ctx.layer, above the frozen
 * frame, its cracks and their glow; beat 2 draws above it. -> the host (its .black is the plate). Pass the seam's host
 * to keep its painter for beat 2; without one, a host is made here and closed (painter dropped) when the leak ends.
 */
export async function crackOutLeak(ctx, stats = {}, host = null) {
  const h = host ?? new CrackOutHost(ctx, stats);
  try { await h.leak(); } catch (e) { warn("nidhogg-crack-out: the leak threw; black", e); try { h.endLeak(); } catch { h.black.style.opacity = "1"; } }
  if (!host) h.close();
  return h;
}

/**
 * Beat 2, from the black beat 1 left (ctx.layer holds an opaque black plate), painted by the same host and painter:
 * resolves once the eyes are gone and the screen is black again (at dark: EYES_MS x speed after beat 1, nominally).
 * Without a live host there is nothing to paint with: it holds the black for EYES_MS.
 */
export async function crackOutEyes(ctx, host = null) {
  const S = Math.max(0.1, Number(ctx?.speed) || 1);
  if (!host || host.closed || !ctx?.layer) { await wait(EYES_MS * S); return; }
  try { await host.eyes(); } catch (e) { warn("nidhogg-crack-out: the eyes threw; black", e); try { host.endEyes(); } catch { /* gone */ } }
}

/* ── The seam ─────────────────────────────────────────────────────────────── */

/** The crack-out (see the header): beat 1, then beat 2, on one host; the painter is dropped at the end. */
export async function nidhoggCrackOut(ctx) {
  const S = Math.max(0.1, Number(ctx?.speed) || 1);
  if (!ctx?.layer) { await wait(CRACK_OUT_MS * S); return; }
  const stats = { at: new Date().toISOString(), W: ctx.W, H: ctx.H, speed: S, nominalMs: CRACK_OUT_MS };
  _last = stats;
  const t0 = performance.now();
  const host = new CrackOutHost(ctx, stats);
  try {
    await crackOutLeak(ctx, stats, host);
    stats.beat1Ms = Math.round(performance.now() - t0);
    if (ctx.torn?.()) { stats.torn = "beat 1"; return; }
    const t1 = performance.now();
    await crackOutEyes(ctx, host);
    stats.beat2Ms = Math.round(performance.now() - t1);
    if (ctx.torn?.()) stats.torn = "beat 2";
  } finally { host.close(); }
  stats.totalMs = Math.round(performance.now() - t0);
  log(`nidhogg-crack-out: over in ${stats.totalMs} ms (leak ${stats.beat1Ms}, eyes ${stats.beat2Ms}: painter ${stats.mode ?? "-"}, ready ${stats.readyMs ?? "-"} ms, ${stats.frames ?? 0} + ${stats.eyes?.frames ?? 0} frames, worker p95 ${stats.worker?.p95 ?? "-"} / ${stats.eyes?.worker?.p95 ?? "-"} ms, rAF p95 ${stats.raf?.p95 ?? "-"} / ${stats.eyes?.raf?.p95 ?? "-"} ms)`);
}

/* ── Rigs ─────────────────────────────────────────────────────────────────── */

/**
 * Play the crack-out on THIS client over whatever is on screen, without a battle (the shatter's own crack, then the
 * crack-out; the overlay goes after it and the scene shows again). -> the stats (also __FU_CRACK_OUT__.last()).
 */
async function preview({ speed } = {}) {
  const sh = globalThis.FUCompanion?.api?.shatter;
  if (!sh?.play) throw new Error("no shatter api (FUCompanion.api.shatter)");
  await sh.play({ load: () => wait(300), cast: [], ...(speed ? { speed } : {}), crackOut: () => nidhoggCrackOut });
  return _last;
}

if (typeof globalThis.window !== "undefined") {
  globalThis.__FU_CRACK_OUT__ = { last: () => _last, preview, CRACK_OUT_MS, LEAK_MS, EYES_MS, plan: () => crackOutPlan() };
}
