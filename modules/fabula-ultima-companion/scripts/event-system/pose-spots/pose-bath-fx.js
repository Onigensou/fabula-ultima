/**
 * [ONI] Event System — Bathing effects (ripples at the waterline)
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/pose-spots/pose-bath-fx.js
 *
 * What this does:
 * - Draws, for every bathing character (flags.fabula-ultima-companion.pose
 *   with pose "bath"), a water surface at their waterline: a soft filled
 *   ellipse that hides the hard cut of the sprite (sprite-facing-runtime.js
 *   cuts the art there), an outline, and rings that widen and fade, stronger
 *   while they wade.
 * - The colour is the water's own, so any map works (blue lakes, the
 *   Wyrmwood's glowing red springs, a green swamp): sampled from the scene's
 *   map pixels inside the bath Region at load (median of the mid-bright
 *   ones), unless the Region sets one (flags...bath.autoColor false + color).
 *
 * Client-local drawing only; nothing is written.
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][PoseBathFx]";

  window.oni = window.oni || {};
  if (window.oni.PoseBathFx?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const POSE_FLAG = "pose";
  const BATH_FLAG = "bath";

  const FALLBACK_COLOR = 0x6fb8e8;   // when nothing can be sampled
  const RING_MS = 2400;              // one ring's life
  const SURFACE_ALPHA = 0.3;   // light: the faint body under the water shows through
  const RING_ALPHA_STILL = 0.45;
  const RING_ALPHA_WADING = 0.75;
  const SAMPLE_STEP_PX = 10;

  const state = {
    installed: true,
    gfx: new Map(),       // tokenId -> { g, lastX, lastY, movingUntil }
    colors: new Map(),    // regionId -> { base, ring }
    tickerFn: null
  };

  // ------------------------------------------------------------
  // Colour
  // ------------------------------------------------------------
  const toHex = (r, g, b) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  const lighten = (c, t) => toHex(((c >> 16) & 255) + ((255 - ((c >> 16) & 255)) * t), ((c >> 8) & 255) + ((255 - ((c >> 8) & 255)) * t), (c & 255) + ((255 - (c & 255)) * t));

  // The map image's pixels, read once per scene (2D canvas copy of the background).
  let mapPixels = null;
  function readMapPixels() {
    if (mapPixels?.sceneId === canvas.scene?.id) return mapPixels;
    mapPixels = null;
    try {
      const src = canvas.primary?.background?.texture?.baseTexture?.resource?.source;
      if (!src || !(src.width || src.videoWidth)) return null;
      const w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(src, 0, 0, w, h);
      mapPixels = { sceneId: canvas.scene.id, w, h, data: ctx.getImageData(0, 0, w, h).data };
    } catch (e) {
      console.debug(INSTALL_TAG, "Could not read the map pixels; ripples use a default colour.", e?.message ?? e);
    }
    return mapPixels;
  }

  function shapesBounds(doc) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of doc?.shapes ?? []) {
      if (s.type === "polygon") for (let i = 0; i < (s.points?.length ?? 0); i += 2) { x0 = Math.min(x0, s.points[i]); x1 = Math.max(x1, s.points[i]); y0 = Math.min(y0, s.points[i + 1]); y1 = Math.max(y1, s.points[i + 1]); }
      else if (Number.isFinite(s.x)) { const hw = s.radiusX ?? 0, hh = s.radiusY ?? 0; x0 = Math.min(x0, s.x - hw); y0 = Math.min(y0, s.y - hh); x1 = Math.max(x1, s.x + (s.width ?? hw)); y1 = Math.max(y1, s.y + (s.height ?? hh)); }
    }
    return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
  }

  function sampleRegionColor(region) {
    const px = readMapPixels();
    const rect = canvas.dimensions?.sceneRect;
    if (!px || !rect) return FALLBACK_COLOR;
    const b = region.bounds ?? region.document?.bounds ?? shapesBounds(region.document);
    if (!b) return FALLBACK_COLOR;
    const samples = [];
    for (let y = b.y; y < b.y + b.height; y += SAMPLE_STEP_PX) {
      for (let x = b.x; x < b.x + b.width; x += SAMPLE_STEP_PX) {
        let inside = false;
        try { inside = region.testPoint({ x, y }, 0); } catch (_) {}
        if (!inside) continue;
        const ix = Math.floor(((x - rect.x) / rect.width) * px.w), iy = Math.floor(((y - rect.y) / rect.height) * px.h);
        if (ix < 0 || iy < 0 || ix >= px.w || iy >= px.h) continue;
        const i = ((iy * px.w) + ix) * 4;
        samples.push([px.data[i], px.data[i + 1], px.data[i + 2]]);
      }
    }
    if (samples.length < 8) return FALLBACK_COLOR;
    // The middle half by brightness: no highlights, no deep shadow.
    samples.sort((a, b2) => (a[0] + a[1] + a[2]) - (b2[0] + b2[1] + b2[2]));
    const mid = samples.slice(Math.floor(samples.length * 0.25), Math.ceil(samples.length * 0.75));
    const avg = mid.reduce((s, c) => [s[0] + c[0], s[1] + c[1], s[2] + c[2]], [0, 0, 0]).map(v => v / mid.length);
    return toHex(avg[0], avg[1], avg[2]);
  }

  function colorsFor(regionId) {
    let c = state.colors.get(regionId);
    if (c) return c;
    const region = canvas.regions?.get(regionId);
    const flag = region?.document?.getFlag?.(MODULE_ID, BATH_FLAG) ?? {};
    let base = FALLBACK_COLOR;
    if (flag.autoColor === false && typeof flag.color === "string" && /^#?[0-9a-f]{6}$/i.test(flag.color)) {
      base = parseInt(flag.color.replace("#", ""), 16);
    } else if (region) {
      base = sampleRegionColor(region);
    }
    c = { base, ring: lighten(base, 0.45) };
    state.colors.set(regionId, c);
    return c;
  }

  // ------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------
  // A Graphics that sorts among the tokens of the primary canvas group (by
  // elevation, sort layer and sort). Foundry 12.343 exports the mixin, not a
  // ready PrimaryGraphics class.
  let RippleGraphics = null;
  function rippleClass() {
    if (RippleGraphics) return RippleGraphics;
    const Mixin = globalThis.PrimaryCanvasObjectMixin;
    const Ready = globalThis.PrimaryGraphics ?? foundry.canvas?.primary?.PrimaryGraphics;
    RippleGraphics = Ready ?? (Mixin ? class extends Mixin(PIXI.Graphics) {} : null);
    return RippleGraphics;
  }

  // Two layers per bather: the far half of every ellipse is drawn just behind
  // them (their body hides it), the near half just in front (it crosses the
  // body), as a ring around someone standing in water does.
  function graphicsFor(token) {
    let rec = state.gfx.get(token.id);
    if (rec && !rec.back.destroyed && !rec.front.destroyed) return rec;
    if (rec) dropGraphics(token.id);
    const Cls = rippleClass();
    if (!Cls) return null;
    const back = new Cls(), front = new Cls();
    canvas.primary.addChild(back);
    canvas.primary.addChild(front);
    rec = { back, front, lastX: token.x, lastY: token.y, movingUntil: 0 };
    state.gfx.set(token.id, rec);
    return rec;
  }

  function dropGraphics(tokenId) {
    const rec = state.gfx.get(tokenId);
    if (!rec) return;
    state.gfx.delete(tokenId);
    try { rec.back.destroy(); } catch (_) {}
    try { rec.front.destroy(); } catch (_) {}
  }

  // Half an ellipse as a polygon: the near half (below the centre, toward the
  // viewer) or the far half. Closed along the diameter when filled.
  function halfEllipse(cx, cy, rx, ry, near, steps = 18) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const a = near ? (Math.PI * i / steps) : (Math.PI + (Math.PI * i / steps));
      pts.push(cx + (Math.cos(a) * rx), cy + (Math.sin(a) * ry));
    }
    return pts;
  }

  function strokeHalf(g, cx, cy, rx, ry, near, width, color, alpha) {
    const pts = halfEllipse(cx, cy, rx, ry, near);
    g.lineStyle(width, color, alpha).moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  }

  function draw(token, now) {
    const pose = token.document?.getFlag?.(MODULE_ID, POSE_FLAG);
    const mesh = token.mesh;
    if (pose?.pose !== "bath" || !mesh || mesh.destroyed || !token.visible) { dropGraphics(token.id); return; }
    const rec = graphicsFor(token);
    if (!rec) return;
    const { base, ring } = colorsFor(pose.regionId);

    if (Math.hypot(token.x - rec.lastX, token.y - rec.lastY) > 0.5) rec.movingUntil = now + 300;
    rec.lastX = token.x; rec.lastY = token.y;
    const wading = now < rec.movingUntil;

    // The waterline: the bottom edge of the cut art, without the bob.
    const w = Math.abs(mesh.width);
    const h = Math.abs(mesh.height);
    const cx = mesh.x + ((0.5 - mesh.anchor.x) * w * Math.sign(mesh.scale.x || 1));
    const wy = mesh.y + ((1 - mesh.anchor.y) * h);
    const rx = w * 0.42, ry = Math.max(4, w * 0.13);

    const ringAlpha = wading ? RING_ALPHA_WADING : RING_ALPHA_STILL;
    const sort = mesh.sort ?? 0;
    for (const [g, near] of [[rec.back, false], [rec.front, true]]) {
      g.elevation = token.document.elevation ?? 0;
      g.sortLayer = mesh.sortLayer;
      // Far half just behind the bather, near half just in front; both still
      // behind anyone standing nearer the viewer.
      g.sort = near ? sort + 0.5 : sort - 0.5;
      g.clear();
      g.beginFill(base, SURFACE_ALPHA).drawPolygon(halfEllipse(cx, wy, rx, ry, near)).endFill();
      strokeHalf(g, cx, wy, rx, ry, near, 1.5, ring, 0.85);
      for (let k = 0; k < 2; k++) {
        const t = ((now / RING_MS) + (k / 2)) % 1;
        const grow = 1 + (t * 0.7);
        strokeHalf(g, cx, wy, rx * grow, ry * grow, near, 1, ring, (1 - t) * ringAlpha);
      }
    }
  }

  function tick() {
    if (!canvas?.ready) return;
    try {
      const now = performance.now();
      const seen = new Set();
      for (const token of canvas.tokens?.placeables ?? []) {
        if (token.document?.getFlag?.(MODULE_ID, POSE_FLAG)?.pose === "bath") { seen.add(token.id); draw(token, now); }
      }
      for (const id of [...state.gfx.keys()]) if (!seen.has(id)) dropGraphics(id);
    } catch (e) {
      const now = Date.now();
      if (now - (state.lastWarnAt ?? 0) > 5000) { state.lastWarnAt = now; console.warn(INSTALL_TAG, "Ripple update failed.", e); }
    }
  }

  function attach() {
    if (state.tickerFn || !canvas?.app?.ticker) return;
    state.tickerFn = tick;
    // After Foundry's refresh and the pose hold, before the frame is drawn.
    canvas.app.ticker.add(state.tickerFn, null, PIXI.UPDATE_PRIORITY.LOW - 1);
  }

  function detach() {
    if (state.tickerFn && canvas?.app?.ticker) canvas.app.ticker.remove(state.tickerFn);
    state.tickerFn = null;
    for (const id of [...state.gfx.keys()]) dropGraphics(id);
    state.colors.clear();
    mapPixels = null;
  }

  Hooks.on("canvasReady", attach);
  Hooks.on("canvasTearDown", detach);
  // A Region's bath colour changed: sample or read it again.
  Hooks.on("updateRegion", (doc) => state.colors.delete(doc.id));
  Hooks.once("ready", () => { if (canvas?.ready) attach(); });

  window.oni.PoseBathFx = { installed: true, state, colorsFor };
  console.debug(INSTALL_TAG, "Installed.");
})();
