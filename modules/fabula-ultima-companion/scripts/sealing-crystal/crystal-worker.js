// ============================================================================
// Sealing Crystal — the painter, off the main thread.
//
// The crystal is a 3D solid painted pixel by pixel every frame (crystal-render.js):
// 8-19 ms a frame idle, 25-36 ms while it dies (measured in Node on this PC,
// 2026-11-10). On the main thread that would eat a 60 fps frame budget whole, so
// it is painted HERE, in a module Worker, and the host (crystal-runtime.js) only
// uploads the finished frame as two textures.
//
// Protocol (one Worker serves every crystal; each has an id):
//   in  { type: "init", id, W, H, seed }                  -> out { type: "ready", id }
//   in  { type: "draw", id, seq, t, st, color?, light? }  -> out { type: "frame", id, seq, ms, color, light, cRect, lRect }
//         color / light: ArrayBuffers of W*H*4, PREMULTIPLIED, handed back for reuse (transferred both ways);
//         cRect / lRect: the box of non-empty pixels [x0, y0, x1, y1] or null
//   in  { type: "drop", id }
// `st` is crystal-render.js draw()'s state minus the mesh (built here from `seed`).
// A painter may instead be one of Nidhogg's fall layers (fall-painter.js): init carries
// { painter: "fall", fall: { layer, kind, ... } } and draw carries { T, t } (st unused).
// Or Nidhogg's return smoke (return-painter.js): init { painter: "return", returnSmoke: { cam, at, src, seed, body,
// under, genW, layers? } }; draw { T (tau), st: { view }, back, front, veil } -> out { type: "frame", id, seq, ms, msBy,
// layers: { back, front, veil }, rects: { back, front, veil } } (PREMULTIPLIED buffers, transferred both ways; only
// the painter's own `layers`: WP6 runs back and front as two painters in two Workers, crystal-host-lib channel(lane)).
// Smoke perf pass (2026-11-16): a fall smoke painter may paint a BAND (fall: { ..., band: [y0, y1) }; its buffers are the
// band's rows, its rects the whole frame's: two painters on two lanes, joined by the show). JIT warm-up, nothing shown:
//   in  { type: "warm", id, seq, job: "draw", T, st }  (the painter's own draw at T into its scratch buffers: return)
//        it may carry reserve: px (smoke-cloud.js reserveCloud: the cloud's buffers sized for the whole frame)
//   -> out { type: "warm", id, seq, ms }
// A REHEARSAL (Nidhogg's first fall, 2026-11-16): a throwaway fall painter run through a fall's frames so this Worker's JIT
// has the smoke's code optimised before the real fall (a fresh Worker's first engulf frames cost up to ~4x a warm one).
// Nothing is shown and no painter is touched; one frame per task (gapMs apart), so other painters' draws interleave.
//   in  { type: "rehearse", id, W, H, fall, Ts: [T...], gapMs }  -> out { type: "rehearsed", id, frames, ms }
// Or the crystal's DEATH (2026-11-17): { type: "rehearse", id, crystal: { W, H, CX, FLOOR, seed, band }, frames: [{ t, st }],
// gapMs }: a throwaway crystal painter run through death frames, so a lane's first real death frames (and the shatter's
// first, ~40 ms cold) are not its first ones.
//   in  { type: "drop", id } stops it.
// Or Nidhogg's battle-opening CRACK-OUT, the leak then his eyes (crack-out-painter.js, 2026-11-20): init { painter:
// "crackout", crackOut: { PX, strokes, impact, U, look? } } (W x H = the effect frame; the leak is built before "ready",
// ~140 ms); draw { T, color?, light? } -> the usual "frame", but STRAIGHT (not premultiplied) RGBA: in the leak, color +
// cRect and a 0-byte light (lRect null); in the eyes, color + light (their glow, additive) and both rects. One painter
// serves both beats.
// The leak may be painted in BANDS (2026-11-20): crackOut { ..., band: [y0, y1), eyes? }: its leak frames are the band's
// rows (W x (y1 - y0), cRect in the whole frame's rows), two painters on two lanes joined by the host; eyes: false = a
// band painter that never paints the eyes (nidhogg-crack-out.js). crackOut.warm: [T...]: frames drawn and thrown away
// before "ready" (a fresh Worker's JIT warm-up); "ready" then carries warmMs.
// Errors come back as { type: "error", id, seq, message }.
// ============================================================================

import { makeCrystalPainter } from "./crystal-painter.js";
import { makeFallPainter } from "./fall-painter.js";
import { makeReturnPainter } from "./return-painter.js";
import { makeCrackOutPainter } from "./crack-out-painter.js";
import { reserveCloud } from "./smoke-cloud.js";

const painters = new Map();
const rehearsals = new Map();   // id -> { stop: true } once dropped

function rehearse(m) {
  const run = { stop: false };
  rehearsals.set(m.id, run);
  const p = m.crystal ? makeCrystalPainter(m.crystal) : makeFallPainter({ ...m.fall, W: m.W, H: m.H });
  // keepAs: the painter stays here under that id when the rehearsal ends or is stopped, for a death to ADOPT (init
  // adopt: the same painter, its JIT and its buffers already made) instead of making a cold one
  if (m.keepAs) painters.set(m.keepAs, p);
  const Ts = m.crystal ? (Array.isArray(m.frames) ? m.frames : []) : Array.isArray(m.Ts) ? m.Ts : [], gap = Math.max(0, Number(m.gapMs) || 0);
  let i = 0, ms = 0, spare = {};
  const next = () => {
    if (run.stop) return;
    try {
      if (i < Ts.length) {
        const o = m.crystal ? p.draw({ t: Ts[i].t, st: Ts[i].st, color: spare.color, light: spare.light }) : p.draw({ T: Ts[i], t: Ts[i], color: spare.color, light: spare.light });
        ms += o.ms; spare = { color: o.color, light: o.light }; i++;
        setTimeout(next, gap);
        return;
      }
      rehearsals.delete(m.id);
      self.postMessage({ type: "rehearsed", id: m.id, frames: i, ms });
    } catch (err) {
      rehearsals.delete(m.id);
      self.postMessage({ type: "error", id: m.id, message: String(err?.stack ?? err) });
    }
  };
  setTimeout(next, 0);
}

self.onmessage = (e) => {
  const m = e.data ?? {};
  try {
    if (m.type === "init") {
      const kept = m.adopt ? painters.get(m.adopt) : null, same = (a, b) => (a == null && b == null) || (Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1]);
      if (kept && kept.W === m.W && kept.H === m.H && same(kept.band ?? null, m.band ?? null)) {
        // (its rehearsal was stopped first: the host drops it before the death's first draw)
        painters.delete(m.adopt); painters.set(m.id, kept);
        self.postMessage({ type: "ready", id: m.id, adopted: true });
        return;
      }
      const p = m.painter === "fall" ? makeFallPainter({ ...m.fall, W: m.W, H: m.H })
        : m.painter === "return" ? makeReturnPainter({ ...m.returnSmoke, W: m.W, H: m.H })
        : m.painter === "crackout" ? makeCrackOutPainter({ ...m.crackOut, W: m.W, H: m.H })
        : makeCrystalPainter(m);
      painters.set(m.id, p);
      // the crack-out's JIT warm-up (crackOut.warm: [T...]): those frames drawn and thrown away before "ready", so a
      // fresh Worker's first pass through the leak's code is not a real frame (see crack-out-painter.js LEAK_WARM_TS)
      let warmMs = 0;
      if (m.painter === "crackout" && Array.isArray(m.crackOut?.warm) && m.crackOut.warm.length) {
        const t = performance.now();
        for (const T of m.crackOut.warm) p.draw({ T });
        warmMs = performance.now() - t;
      }
      self.postMessage(warmMs ? { type: "ready", id: m.id, warmMs } : { type: "ready", id: m.id });
    } else if (m.type === "draw") {
      const p = painters.get(m.id);
      if (!p) return;
      const out = p.draw(m);
      if (out.layers) { self.postMessage({ type: "frame", id: m.id, seq: m.seq, ms: out.ms, msBy: out.msBy, layers: out.layers, rects: out.rects }, Object.values(out.layers)); return; }
      self.postMessage({ type: "frame", id: m.id, seq: m.seq, ms: out.ms, color: out.color, light: out.light, cRect: out.cRect, lRect: out.lRect }, [out.color, out.light]);
    } else if (m.type === "warm") {
      const p = painters.get(m.id);
      if (m.reserve > 0) reserveCloud(m.reserve);
      const ms = m.job === "draw" && p ? p.draw({ ...m, warm: true }).ms : 0;
      self.postMessage({ type: "warm", id: m.id, seq: m.seq, ms });
    } else if (m.type === "rehearse") {
      rehearse(m);
    } else if (m.type === "drop") {
      painters.delete(m.id);
      const r = rehearsals.get(m.id);
      if (r) { r.stop = true; rehearsals.delete(m.id); }
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, seq: m.seq, message: String(err?.stack ?? err) });
  }
};
