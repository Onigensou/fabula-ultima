// ============================================================================
// Smoke frames that clear and premultiply only where something was drawn
// (smoke perf pass, 2026-11-16; pixel-identical). Pure: no DOM, no Foundry.
//
// The fall's smoke frame is the whole visible arena (~881 x 514) and the
// return's two smoke layers are as big; clearing both buffers and
// premultiplying them whole cost ~2.4 ms every fall frame, most of it over
// empty pixels. Here:
//   - BoxPainter: the pixelfx Painter that also keeps the box of every pixel
//     it wrote (color and light apart). Code that writes the buffers straight
//     (smoke-cloud.js, the fall's engulf) marks its own box (markC).
//   - makeBoxFrame: a frame cleared only inside last frame's boxes: every
//     non-zero pixel lies in them, so the frame is all zeros after, exactly
//     as after a whole clear (clearFrame).
//   - premultiplyBox: crystal-painter.js premultiply() over a box only, the
//     same arithmetic, the same exact non-empty rect.
//   - DstTrack: which part of a handed-back buffer can be non-zero. The host
//     hands back the buffer this painter returned LAST (one frame in flight,
//     one spare), or none (a new, zeroed one). Premultiplying over
//     (this frame's box U that buffer's last rect) then leaves the whole
//     buffer exactly what a whole premultiply would. A painter that does not
//     know (new painter, a draw that threw) premultiplies whole.
// ============================================================================

import { Painter, createFrame, clamp } from "../battle-director/pixel-entrance/pixelfx/core/index.js";

/** The Painter, plus the box of what it wrote: color (cx0..cx1, cy0..cy1) and light (lx0..), frame px, inclusive. */
export class BoxPainter extends Painter {
  constructor(frame) {
    super(frame);
    this.unbox();
  }
  /** Forget the boxes (nothing written yet). */
  unbox() {
    this.cx0 = this.cy0 = this.lx0 = this.ly0 = Infinity;
    this.cx1 = this.cy1 = this.lx1 = this.ly1 = -Infinity;
    return this;
  }
  /** Mark a box of COLOR pixels as written, in screen px (as put() takes them); clipped to the frame. */
  markC(sx0, sy0, sx1, sy1) {
    const x0 = Math.max(0, Math.floor(sx0) - this.ox), y0 = Math.max(0, Math.floor(sy0) - this.oy);
    const x1 = Math.min(this.w - 1, Math.ceil(sx1) - this.ox), y1 = Math.min(this.h - 1, Math.ceil(sy1) - this.oy);
    if (x1 < x0 || y1 < y0) return;
    if (x0 < this.cx0) this.cx0 = x0;
    if (x1 > this.cx1) this.cx1 = x1;
    if (y0 < this.cy0) this.cy0 = y0;
    if (y1 > this.cy1) this.cy1 = y1;
  }
  /** Paint only screen rows lo..hi (inclusive); writes off them are dropped (a crystal painted in bands). */
  rows(lo = -Infinity, hi = Infinity) { this.rowLo = lo; this.rowHi = hi; return this; }
  put(sx, sy, c, a = 1) {
    if (sy < this.rowLo || sy > this.rowHi) return;
    if (c) {
      const x = sx - this.ox, y = sy - this.oy;
      if (x >= 0 && y >= 0 && x < this.w && y < this.h) {
        if (x < this.cx0) this.cx0 = x;
        if (x > this.cx1) this.cx1 = x;
        if (y < this.cy0) this.cy0 = y;
        if (y > this.cy1) this.cy1 = y;
      }
    }
    super.put(sx, sy, c, a);
  }
  blendPx(sx, sy, c, a) {
    if (sy < this.rowLo || sy > this.rowHi) return;
    if (c) {
      const x = sx - this.ox, y = sy - this.oy;
      if (x >= 0 && y >= 0 && x < this.w && y < this.h) {
        if (x < this.cx0) this.cx0 = x;
        if (x > this.cx1) this.cx1 = x;
        if (y < this.cy0) this.cy0 = y;
        if (y > this.cy1) this.cy1 = y;
      }
    }
    super.blendPx(sx, sy, c, a);
  }
  // add, glow and glowLine: the Painter's own, with the box kept and Painter.add's arithmetic written in (no call
  // through super a pixel; their call sites only ever see a BoxPainter): the same pixels (crystal death 60 fps
  // pass, 2026-11-17: the death's light is ~700k of these a frame)
  add(sx, sy, c, k = 1) {
    if (sy < this.rowLo || sy > this.rowHi) return;
    const x = sx - this.ox, y = sy - this.oy;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (x < this.lx0) this.lx0 = x;
    if (x > this.lx1) this.lx1 = x;
    if (y < this.ly0) this.ly0 = y;
    if (y > this.ly1) this.ly1 = y;
    k *= this.fade * this.lightK;
    if (k <= 0.004) return;
    const L = this.L, i = y * this.w + x, d = L[i];
    const r = Math.min(255, (d & 255) + (c & 255) * k) | 0;
    const g = Math.min(255, ((d >>> 8) & 255) + ((c >>> 8) & 255) * k) | 0;
    const b = Math.min(255, ((d >>> 16) & 255) + ((c >>> 16) & 255) * k) | 0;
    L[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
  // A glow's faint rim adds nothing: add() drops a pixel whose f^2 k (x fade x lightK) is 0.004 or less, so below
  // f = s (sqrt(0.004 / (k fade lightK)), a hair under) no pixel is written; only the disc / capsule where f >= s is
  // visited (rr = r (1 - s), + 1 px), with the same tests. Those pixels are not marked in the box either (nothing is
  // written there; the box only has to hold what was). A faint glow is a much smaller disc. The pixel is then written
  // as add() writes it (the same arithmetic), off-frame and off-row pixels never visited, the box kept per call.
  glow(x, y, r, c, k = 0.5) {
    if (r < 1 || k <= 0.004) return;
    const kk = k * this.fade * this.lightK;
    if (!(kk > 0.004)) return;
    const s = Math.sqrt(0.004 / kk) * (1 - 1e-7), rr = r * (1 - s) + 1;
    const cx = this.toX(x, y), cy = this.toY(x, y);
    const fm = this.fade * this.lightK, L = this.L, w = this.w, ox = this.ox, oy = this.oy;
    const sxLo = ox, sxHi = ox + w - 1, syLo = Math.max(oy, this.rowLo), syHi = Math.min(oy + this.h - 1, this.rowHi);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const x0 = Math.max(sxLo, Math.floor(cx - r), Math.floor(cx - rr)), x1 = Math.min(sxHi, Math.ceil(cx + r), Math.ceil(cx + rr));
    const y0 = Math.max(syLo, Math.floor(cy - r), Math.floor(cy - rr)), y1 = Math.min(syHi, Math.ceil(cy + r), Math.ceil(cy + rr));
    for (let sy = y0; sy <= y1; sy++) {
      const dy = (sy + 0.5 - cy) / r, dyp = sy + 0.5 - cy;
      if (dyp * dyp >= rr * rr) continue;
      const hw = Math.sqrt(rr * rr - dyp * dyp) + 1, xa = Math.max(x0, Math.floor(cx - hw - 0.5)), xb = Math.min(x1, Math.ceil(cx + hw - 0.5));
      for (let sx = xa; sx <= xb; sx++) {
        const dx = (sx + 0.5 - cx) / r, d = dx * dx + dy * dy;
        if (d >= 1) continue;
        const f = 1 - Math.sqrt(d);
        if (f < s) continue;
        let kq = f * f * k;
        kq *= fm;
        if (kq <= 0.004) continue;
        const x = sx - ox, y = sy - oy, i = y * w + x, dv = L[i];
        const rC = Math.min(255, (dv & 255) + (c & 255) * kq) | 0;
        const gC = Math.min(255, ((dv >>> 8) & 255) + ((c >>> 8) & 255) * kq) | 0;
        const bC = Math.min(255, ((dv >>> 16) & 255) + ((c >>> 16) & 255) * kq) | 0;
        L[i] = (255 << 24) | (bC << 16) | (gC << 8) | rC;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
    if (bx1 >= bx0) {
      if (bx0 < this.lx0) this.lx0 = bx0;
      if (bx1 > this.lx1) this.lx1 = bx1;
      if (by0 < this.ly0) this.ly0 = by0;
      if (by1 > this.ly1) this.ly1 = by1;
    }
  }
  glowLine(x0, y0, x1, y1, r, c, k = 0.5) {
    if (r < 1 || k <= 0.004) return;
    const kk = k * this.fade * this.lightK;
    if (!(kk > 0.004)) return;
    const s = Math.sqrt(0.004 / kk) * (1 - 1e-7);
    const ax = this.toX(x0, y0), ay = this.toY(x0, y0), bx = this.toX(x1, y1), by = this.toY(x1, y1);
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
    const X0 = Math.floor(Math.min(ax, bx) - r), X1 = Math.ceil(Math.max(ax, bx) + r);
    const Y0 = Math.floor(Math.min(ay, by) - r), Y1 = Math.ceil(Math.max(ay, by) + r);
    const R1 = r * (1 - s) + 1;
    const fm = this.fade * this.lightK, L = this.L, w = this.w, ox = this.ox, oy = this.oy;
    const sxLo = ox, sxHi = ox + w - 1, syLo = Math.max(oy, this.rowLo), syHi = Math.min(oy + this.h - 1, this.rowHi);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let sy = Math.max(Y0, syLo), yEnd = Math.min(Y1, syHi); sy <= yEnd; sy++) {
      const py0 = sy + 0.5;
      let xa = Math.max(X0, sxLo), xb = Math.min(X1, sxHi);
      if (Math.abs(dy) > 1e-9) {
        let t0 = (py0 - R1 - ay) / dy, t1 = (py0 + R1 - ay) / dy;
        if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; }
        if (t1 < 0 || t0 > 1) continue;
        t0 = Math.max(0, t0); t1 = Math.min(1, t1);
        const xs0 = ax + dx * t0, xs1 = ax + dx * t1;
        xa = Math.max(xa, Math.floor(Math.min(xs0, xs1) - R1)); xb = Math.min(xb, Math.ceil(Math.max(xs0, xs1) + R1));
      } else if (Math.abs(ay - py0) > R1) continue;
      for (let sx = xa; sx <= xb; sx++) {
        const px = sx + 0.5, py = sy + 0.5, u = clamp(((px - ax) * dx + (py - ay) * dy) / L2);
        const ex = ax + dx * u - px, ey = ay + dy * u - py, d = Math.sqrt(ex * ex + ey * ey) / r;
        if (d >= 1) continue;
        const f = 1 - d;
        if (f < s) continue;
        let kq = f * f * k;
        kq *= fm;
        if (kq <= 0.004) continue;
        const x = sx - ox, y = sy - oy, i = y * w + x, dv = L[i];
        const rC = Math.min(255, (dv & 255) + (c & 255) * kq) | 0;
        const gC = Math.min(255, ((dv >>> 8) & 255) + ((c >>> 8) & 255) * kq) | 0;
        const bC = Math.min(255, ((dv >>> 16) & 255) + ((c >>> 16) & 255) * kq) | 0;
        L[i] = (255 << 24) | (bC << 16) | (gC << 8) | rC;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
    if (bx1 >= bx0) {
      if (bx0 < this.lx0) this.lx0 = bx0;
      if (bx1 > this.lx1) this.lx1 = bx1;
      if (by0 < this.ly0) this.ly0 = by0;
      if (by1 > this.ly1) this.ly1 = by1;
    }
  }
  /** The boxes written since unbox(): [x0, y0, x1, y1] (frame px, inclusive) or null. */
  boxC() { return this.cx1 < this.cx0 ? null : [this.cx0, this.cy0, this.cx1, this.cy1]; }
  boxL() { return this.lx1 < this.lx0 ? null : [this.lx0, this.ly0, this.lx1, this.ly1]; }
}

/**
 * The box of DIRECT writes: code that writes a frame's arrays straight, not through a Painter (the crystal's
 * rasteriser, crystal-render.js / crystal-death.js), marks every box it may write (a triangle's clipped bounds, a
 * line's ends, a loop's range): a superset of what it wrote. One shared box: a painter's draw resets it, marks, reads
 * it (draws never interleave: a Worker paints one frame at a time). Crystal death 60 fps pass, 2026-11-17.
 */
export class WriteBox {
  constructor() { this.reset(); }
  reset() { this.x0 = this.y0 = Infinity; this.x1 = this.y1 = -Infinity; return this; }
  mark(x0, y0, x1, y1) {
    if (x0 < this.x0) this.x0 = x0;
    if (y0 < this.y0) this.y0 = y0;
    if (x1 > this.x1) this.x1 = x1;
    if (y1 > this.y1) this.y1 = y1;
  }
  px(x, y) { this.mark(x, y, x, y); }
  /** The box, whole pixels clipped to W x H, or null. */
  box(W, H) {
    const x0 = Math.max(0, Math.floor(this.x0)), y0 = Math.max(0, Math.floor(this.y0));
    const x1 = Math.min(W - 1, Math.ceil(this.x1)), y1 = Math.min(H - 1, Math.ceil(this.y1));
    return x1 < x0 || y1 < y0 ? null : [x0, y0, x1, y1];
  }
}
export const DIRECT = new WriteBox();
/**
 * The screen rows code that writes a frame straight may write (inclusive): all, unless a crystal is painted in a band
 * (crystal-render.js sets it for one draw and puts it back). Every pixel is its own: nothing reads a pixel it did not
 * write on the same row, so a band's rows come out as the whole frame's.
 */
export const CLIP = { lo: -Infinity, hi: Infinity };
/** box cut to rows lo..hi ("full" / null kept; rows null: the box as it is). */
export function rowsOf(box, W, H, lo, hi) {
  if (!box || (lo === -Infinity && hi === Infinity)) return box;
  const [x0, y0, x1, y1] = box === "full" ? [0, 0, W - 1, H - 1] : box, a = Math.max(y0, lo), b = Math.min(y1, hi);
  return b < a ? null : [x0, a, x1, b];
}

/** Box union; "full" (unknown: the whole frame) wins, null is empty. */
export function unionBox(a, b) {
  if (a === "full" || b === "full") return "full";
  if (!a) return b ?? null;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Zero buf (W wide) inside box ("full": all of it; null: nothing). */
export function clearBox(buf, W, box) {
  if (!box) return;
  if (box === "full") { buf.fill(0); return; }
  const [x0, y0, x1, y1] = box;
  if (x0 === 0 && x1 === W - 1) { buf.fill(0, y0 * W, (y1 + 1) * W); return; }
  for (let y = y0; y <= y1; y++) buf.fill(0, y * W + x0, y * W + x1 + 1);
}

/**
 * A frame (W x H, its top row at screen row oy) whose painter keeps boxes, cleared only where it was drawn.
 * begin() -> the painter, the frame all zeros (as clearFrame + painterFor); end() -> { c, l } boxes of what was drawn.
 * A draw that throws between the two leaves the boxes "full", so the next begin() clears everything.
 */
export function makeBoxFrame(W, H, oy = 0) {
  const frame = createFrame(W, H, 0, oy), p = new BoxPainter(frame);
  let cBox = null, lBox = null;   // where the buffers can be non-zero now (a new frame is all zeros)
  return {
    frame, painter: p, W, H, oy,
    begin() {
      clearBox(frame.color, W, cBox); clearBox(frame.light, W, lBox);
      cBox = lBox = "full";
      p.reset(); p.unbox();
      return p;
    },
    end() {
      cBox = p.boxC(); lBox = p.boxL();
      return { c: cBox, l: lBox };
    },
  };
}

/**
 * crystal-painter.js premultiply() over box only (inclusive; "full" = all; null = nothing): dst inside the box is
 * written exactly as premultiply() writes it, dst outside it is left alone. Returns the box of non-empty pixels
 * found [x0, y0, x1, y1], or null. With src zero outside the box and dst zero outside it, this IS premultiply().
 */
export function premultiplyBox(src, dst, W, H, box) {
  if (!box) return null;
  const [bx0, by0, bx1, by1] = box === "full" ? [0, 0, W - 1, H - 1] : box;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = by0; y <= by1; y++) {
    let rowAny = false;
    for (let x = bx0, i = y * W + bx0; x <= bx1; x++, i++) {
      const v = src[i];
      if (v === 0) { dst[i] = 0; continue; }
      const a = v >>> 24;
      if (a === 255) dst[i] = v;
      else if (a === 0) { dst[i] = 0; continue; }
      else {
        const r = ((v & 255) * a + 127) / 255 | 0, g = (((v >>> 8) & 255) * a + 127) / 255 | 0, b = (((v >>> 16) & 255) * a + 127) / 255 | 0;
        dst[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
      }
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      rowAny = true;
    }
    if (rowAny) { if (y < y0) y0 = y; y1 = y; }
  }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

/**
 * One stream of output buffers (W x H): which part of the buffer handed back can be non-zero.
 * out(buf, src, box) -> { u32 (the buffer written), rect }: premultiplies src into buf (or a new buffer) over
 * box U the handed-back buffer's last rect, which is then this frame's rect.
 */
export class DstTrack {
  constructor(W, H) { this.W = W; this.H = H; this.last = "full"; }
  out(buf, src, box) {
    const n = this.W * this.H, known = buf && buf.byteLength === n * 4;
    const u32 = known ? new Uint32Array(buf) : new Uint32Array(n);
    const rect = premultiplyBox(src, u32, this.W, this.H, unionBox(box, known ? this.last : null));
    this.last = rect;
    return { u32, rect };
  }
  /** Something went wrong (a draw threw with the buffers out): premultiply whole next time. */
  lost() { this.last = "full"; }
}

/**
 * A band's frame into a buffer sprite (crystal-host-lib.js bufferSprite / takeFrame, for the fall's smoke painted in
 * bands: fall-painter.js). buf holds the band's rows [band[0], band[1]) only; rect is in the whole frame's rows. As
 * takeFrame, only the rows of (this frame's rect U this band's last rect) are copied and uploaded, so by induction
 * the sprite's buffer is the joined frame everywhere. resetTake() after the sprite was fed some other way (one
 * painter <-> bands): every band then copies its whole rows once.
 */
export function takeBand(s, buf, rect, W, band) {
  const lb = (s.bandLast ??= new Map()), key = band[0];
  const last = lb.has(key) ? lb.get(key) : s.bandDirty ? [0, band[0], W - 1, band[1] - 1] : null;
  lb.set(key, rect);
  const u = unionBox(rect, last);
  if (!u) return;
  const a = (u[1] - band[0]) * W * 4, b = (u[3] + 1 - band[0]) * W * 4;
  s.u8.set(new Uint8Array(buf, a, b - a), u[1] * W * 4);
  s.res.dirty(u);
}
/**
 * takeBand for a painter that paints a band into WHOLE-FRAME buffers (the crystal's death in bands, crystal-painter.js
 * band): the same rows of buf as of the sprite; rect in the band's rows. As takeBand, only (rect U this band's last
 * rect) is copied and uploaded.
 */
export function takeRows(s, buf, rect, W, band) {
  const lb = (s.bandLast ??= new Map()), key = band[0];
  const last = lb.has(key) ? lb.get(key) : s.bandDirty ? [0, band[0], W - 1, band[1] - 1] : null;
  lb.set(key, rect);
  const u = unionBox(rect, last);
  if (!u) return;
  const a = u[1] * W * 4, b = (u[3] + 1) * W * 4;
  s.u8.set(new Uint8Array(buf, a, b - a), a);
  s.res.dirty(u);
}
/** The sprite was fed by bands and now by one painter, or the other way: copy everything once. */
export function resetTake(s, W, H) {
  s.last = [0, 0, W - 1, H - 1];
  s.bandLast = new Map(); s.bandDirty = true;
}

