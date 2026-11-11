// ============================================================================
// Sealing Crystal — what the idle host (crystal-runtime.js) and the death show
// (crystal-death-show.js) share: the painter channel (one Worker for every
// crystal), premultiplied dirty-box texture uploads, and depth placement.
// ============================================================================

import { warn } from "../battle-director/logger.js";
import { shadowSpriteFor, STYLE as SHADOW_STYLE } from "../sprite-shadow/sprite-shadow-renderer.js";

/* ── The painter channel: a Worker, else the main thread ─────────────────── */

let _channel = null;
class Channel {
  constructor() {
    this.listeners = new Map();   // id -> (msg) => void
    this.local = null;            // the fallback painters, once the Worker is gone
    this.mode = "starting";
    try {
      this.worker = new Worker(new URL("./crystal-worker.js", import.meta.url), { type: "module", name: "fu-sealing-crystal" });
      this.worker.onmessage = (e) => this.#deliver(e.data);
      this.worker.onerror = (e) => { warn("sealing-crystal: worker failed, painting on the main thread", e?.message ?? e); this.#fallback(); };
      this.mode = "worker";
    } catch (e) {
      warn("sealing-crystal: no worker, painting on the main thread", e);
      this.#fallback();
    }
  }
  #deliver(m) { if (m?.type === "error") warn(`sealing-crystal: paint threw (${m.id})`, m.message); this.listeners.get(m?.id)?.(m); }
  async #fallback() {
    if (this.local) return;
    try { this.worker?.terminate(); } catch { /* gone */ }
    this.worker = null; this.mode = "local"; this.local = new Map();
    try {
      const [{ makeCrystalPainter }, { makeFallPainter }] = await Promise.all([import("./crystal-painter.js"), import("./fall-painter.js")]);
      this.makeLocal = (o) => (o.painter === "fall" ? makeFallPainter({ ...o.fall, W: o.W, H: o.H }) : makeCrystalPainter(o));
      // whoever was waiting on the Worker starts again here
      for (const fn of this.listeners.values()) fn({ type: "restart" });
    } catch (e) { warn("sealing-crystal: the painter cannot load at all", e); this.mode = "dead"; }
  }
  /**
   * frame: { W, H, CX, FLOOR } (crystal-painter FRAME / DEATH_FRAME). extra (optional): { painter: "fall", fall: {...} }
   * for one of Nidhogg's fall layers (fall-painter.js); its sprite pixels are COPIED to the Worker (kept here for a
   * restart on the main thread).
   */
  init(id, frame, seed, fn, extra = null) {
    this.listeners.set(id, fn);
    const { W, H, CX, FLOOR } = frame;
    const msg = { type: "init", id, W, H, CX, FLOOR, seed, ...(extra ?? {}) };
    if (this.worker) { this.worker.postMessage(msg); return; }
    if (!this.makeLocal) return;   // the fallback is still loading: it sends "restart"
    try { this.local.set(id, this.makeLocal(msg)); }
    catch (e) { warn(`sealing-crystal: painter ${id} failed to start`, e); return; }
    fn({ type: "ready", id });
  }
  /** t: the clock (s); st: the crystal's state, or { T } (s into the fall) for a fall layer. */
  draw(id, seq, t, st, color, light) {
    const T = st?.T;
    if (this.worker) {
      const tr = [color, light].filter((b) => b && b.byteLength);
      this.worker.postMessage({ type: "draw", id, seq, t, T, st, color, light }, tr);
      return;
    }
    const p = this.local?.get(id);
    if (!p) return;
    try { const out = p.draw({ t, T, st, color, light }); this.listeners.get(id)?.({ type: "frame", id, seq, ...out }); }
    catch (e) { this.listeners.get(id)?.({ type: "error", id, seq, message: String(e?.stack ?? e) }); }
  }
  drop(id) {
    this.listeners.delete(id);
    if (this.worker) this.worker.postMessage({ type: "drop", id });
    else this.local?.delete(id);
  }
}
export const channel = () => (_channel ??= new Channel());
export const channelMode = () => _channel?.mode ?? "idle";

/* ── Depth: right after the token's own mesh, sharing its sort keys ─────── */

export function placeAfter(c, mesh) {
  const prim = canvas.primary;
  if (!prim || !mesh || mesh.destroyed) return;
  if (c.elevation !== mesh.elevation || c.sortLayer !== mesh.sortLayer || c.sort !== mesh.sort || c.zIndex !== mesh.zIndex) {
    c.elevation = mesh.elevation; c.sortLayer = mesh.sortLayer; c.sort = mesh.sort; c.zIndex = mesh.zIndex;
    prim.sortDirty = true;
  }
  const i = prim.children.indexOf(mesh), j = prim.children.indexOf(c);
  if (i < 0) { if (j < 0) prim.addChild(c); return; }
  if (j === i + 1) return;
  if (j >= 0) prim.removeChild(c);
  prim.addChildAt(c, prim.children.indexOf(mesh) + 1);
}
export function holdShadow(token, k) {
  try {
    const sh = shadowSpriteFor(token.id);
    if (!sh || sh.destroyed) return;
    const a = SHADOW_STYLE.alpha * k;
    if (sh.fudBase) sh.fudBase.alpha = a;
    sh.alpha = a;
  } catch { /* no shadow */ }
}

/**
 * A pixel buffer texture that uploads only a dirty box. The bytes come PREMULTIPLIED from the painter
 * (crystal-painter.js premultiply), so nothing is converted on upload, and only the box that changed since
 * the last upload goes to the GPU (WebGL2 UNPACK_ROW_LENGTH / SKIP_*: no repacking). Measured 2026-11-10 on an
 * RTX 3060 Ti before this: the two full straight-alpha uploads cost ~2.6 ms of main thread per frame, ~11 ms with
 * the CPU slowed 4x. Anything unusual (first upload, a resize, WebGL1, a lost context) uploads the whole buffer,
 * which is always exact (see takeFrame).
 */
let _SubRect = null;
function subRectResourceClass() {
  if (_SubRect) return _SubRect;
  _SubRect = class SubRectBufferResource extends PIXI.BufferResource {
    constructor(data, opts) { super(data, opts); this.rect = null; this.full = true; }
    /** Mark [x0, y0, x1, y1] (inclusive) for the next upload, joined with anything not uploaded yet. */
    dirty(r) {
      if (!r) return;
      const q = this.rect;
      this.rect = q ? [Math.min(q[0], r[0]), Math.min(q[1], r[1]), Math.max(q[2], r[2]), Math.max(q[3], r[3])] : r.slice();
      this.update();
    }
    upload(renderer, baseTexture, glTexture) {
      const gl = renderer.gl, W = baseTexture.realWidth, H = baseTexture.realHeight, r = this.rect;
      const sub = !this.full && r && glTexture.width === W && glTexture.height === H && renderer.context?.webGLVersion >= 2;
      if (!sub) { this.rect = null; this.full = false; return super.upload(renderer, baseTexture, glTexture); }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, W); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r[0]); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r[1]);
      try { gl.texSubImage2D(baseTexture.target, 0, r[0], r[1], r[2] - r[0] + 1, r[3] - r[1] + 1, baseTexture.format, glTexture.type, this.data); }
      finally { gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0); }
      this.rect = null;
      return true;
    }
  };
  return _SubRect;
}
/** A frame shown as a sprite over a persistent, premultiplied pixel buffer (NEAREST). */
export function bufferSprite(W, H) {
  const u8 = new Uint8Array(W * H * 4);
  const Res = subRectResourceClass(), res = new Res(u8, { width: W, height: H });
  const base = new PIXI.BaseTexture(res, { scaleMode: PIXI.SCALE_MODES.NEAREST, alphaMode: PIXI.ALPHA_MODES.PMA });
  const sp = new PIXI.Sprite(new PIXI.Texture(base));
  return { sp, u8, res, last: null };
}
/**
 * Take a painted frame into a buffer sprite. Only the rows of (this frame's box U the last frame's box) are copied
 * and uploaded: everything outside it was empty in the last frame and is empty now, so the buffer (and the GPU
 * texture) stay exactly the latest frame everywhere, by induction. That is also why a full upload is always right.
 */
export function takeFrame(s, buf, rect, W) {
  const p = s.last, u = rect && p ? [Math.min(rect[0], p[0]), Math.min(rect[1], p[1]), Math.max(rect[2], p[2]), Math.max(rect[3], p[3])] : (rect ?? p);
  s.last = rect;
  if (!u) return;
  const a = u[1] * W * 4, b = (u[3] + 1) * W * 4;
  s.u8.set(new Uint8Array(buf, a, b - a), a);
  s.res.dirty(u);
}

