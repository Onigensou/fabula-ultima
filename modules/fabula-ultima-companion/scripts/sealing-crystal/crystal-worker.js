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
// Errors come back as { type: "error", id, seq, message }.
// ============================================================================

import { makeCrystalPainter } from "./crystal-painter.js";
import { makeFallPainter } from "./fall-painter.js";

const painters = new Map();

self.onmessage = (e) => {
  const m = e.data ?? {};
  try {
    if (m.type === "init") {
      painters.set(m.id, m.painter === "fall" ? makeFallPainter({ ...m.fall, W: m.W, H: m.H }) : makeCrystalPainter(m));
      self.postMessage({ type: "ready", id: m.id });
    } else if (m.type === "draw") {
      const p = painters.get(m.id);
      if (!p) return;
      const out = p.draw(m);
      self.postMessage({ type: "frame", id: m.id, seq: m.seq, ms: out.ms, color: out.color, light: out.light, cRect: out.cRect, lRect: out.lRect }, [out.color, out.light]);
    } else if (m.type === "drop") {
      painters.delete(m.id);
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, seq: m.seq, message: String(err?.stack ?? err) });
  }
};
