/**
 * water-wade.js
 * Fabula Ultima Companion - Wading: characters sink into water Regions
 * Foundry VTT v12
 *
 * Purpose:
 * - Anyone whose feet are inside a water Region sinks into it: the part of
 *   the sprite below the waterline is hidden, and shown again only faintly,
 *   tinted the water's colour and fading out before the feet (no feet seen
 *   gliding: walk art has no wading animation). Ripples are drawn by
 *   event-system/pose-spots/pose-bath-fx.js.
 * - The walk and standing art keep playing as they are: this only lowers the
 *   sprite (mesh pivot) and masks it at the waterline, whatever it shows.
 * - Sinking eases in and out as a character crosses the water's edge.
 *
 * Water is a Region with flags.fabula-ultima-companion.water:
 *   { depth,      share of the sprite's height under water (0 = footsteps only)
 *     bathable,   the "!" bath of event-system/pose-spots
 *     autoColor, color }  ripple / tint colour (sampled from the map by default)
 * Set on the Region Config, Identity tab, "Water" section.
 *
 * Every token on walk maps and camps (not dungeons or battles). A bather (pose
 * "bath") is drawn by sprite-facing-runtime.js instead. Client-local; nothing
 * is written.
 *
 * Globals / API:
 *   window.oni.WaterWade
 */

(() => {
  const INSTALL_TAG = "[ONI][WaterWade]";

  window.oni = window.oni || {};
  if (window.oni.WaterWade?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const WATER_FLAG = "water";
  const EASE_MS = 250;
  const UNDER_ALPHA = 0.35;
  const UNDER_BANDS = 8;
  const UNDER_FADE_SHARE = 0.65;
  const MAX_DEPTH = 0.85;

  const state = {
    installed: true,
    active: false,
    tokens: new Map(),   // tokenId -> { d, target, regionId, mask, under, underKey, waterline }
    maskLayer: null,
    tickerFn: null,
    lastFrame: 0
  };

  // ------------------------------------------------------------
  // Water Regions
  // ------------------------------------------------------------
  function waterOf(regionDoc) {
    const w = regionDoc?.getFlag?.(MODULE_ID, WATER_FLAG);
    const depth = Number(w?.depth);
    if (!(depth > 0)) return null;
    return { depth: Math.min(MAX_DEPTH, depth), bathable: !!w.bathable };
  }

  function waterRegions() {
    return (canvas?.regions?.placeables ?? []).filter(r => !!waterOf(r.document));
  }

  // The deepest water Region under a point.
  function waterAt(point, elevation = 0) {
    let best = null;
    for (const region of waterRegions()) {
      let inside = false;
      try { inside = region.testPoint(point, elevation); } catch (_) {}
      if (!inside) continue;
      const w = waterOf(region.document);
      if (!best || w.depth > best.depth) best = { regionId: region.id, depth: w.depth };
    }
    return best;
  }

  function sceneWades(scene) {
    const mode = scene?.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode ?? null;
    if (mode === "exploration" || mode === "camp") return true;
    if (mode) return false;
    const legacy = scene?.flags?.[MODULE_ID]?.oniFabula?.general?.cameraFollowToken;
    return legacy === true || legacy === "true";
  }

  // ------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------
  let UnderClass = null;
  function underClass() {
    if (UnderClass) return UnderClass;
    const Mixin = globalThis.PrimaryCanvasObjectMixin;
    UnderClass = Mixin ? class extends Mixin(PIXI.Container) {} : null;
    return UnderClass;
  }

  function ensureMaskLayer() {
    if (state.maskLayer && !state.maskLayer.destroyed && state.maskLayer.parent) return state.maskLayer;
    state.maskLayer = new PIXI.Container();
    state.maskLayer.eventMode = "none";
    canvas.stage.addChild(state.maskLayer);
    return state.maskLayer;
  }

  function clearUnder(rec) {
    const u = rec.under;
    rec.under = null;
    rec.underKey = null;
    if (!u) return;
    try {
      for (const band of u.children) band.texture?.destroy(false);
      u.parent?.removeChild(u);
      u.destroy({ children: true });
    } catch (_) {}
  }

  function release(tokenId) {
    const rec = state.tokens.get(tokenId);
    if (!rec) return;
    state.tokens.delete(tokenId);
    const mesh = canvas?.tokens?.get(tokenId)?.mesh;
    if (mesh && !mesh.destroyed) {
      if (mesh.mask === rec.mask) mesh.mask = null;
      mesh.pivot.y = 0;
    }
    try { rec.mask?.destroy(); } catch (_) {}
    clearUnder(rec);
  }

  // The faint part under the water: the sunk rows of the art on show, in
  // bands fading out downward. Rebuilt when the art, its frame or the depth changes.
  function holdUnder(token, rec, sinkTex, color) {
    const mesh = token.mesh;
    const tex = mesh.texture;
    if (!tex?.valid || sinkTex < 1) { clearUnder(rec); return; }
    const f = tex.frame;
    const sink = Math.min(f.height, Math.round(sinkTex));
    const key = `${tex.baseTexture.uid}:${f.x},${f.y},${f.width},${f.height}:${sink}`;

    if (rec.underKey !== key) {
      clearUnder(rec);
      const Cls = underClass();
      if (!Cls) return;
      const u = new Cls();
      const fadeH = Math.max(1, Math.round(sink * UNDER_FADE_SHARE));
      const bandH = Math.max(1, Math.ceil(fadeH / UNDER_BANDS));
      const top = f.height - sink;
      for (let i = 0, y = 0; y < fadeH; i++, y += bandH) {
        const h = Math.min(bandH, fadeH - y);
        const band = new PIXI.Sprite(new PIXI.Texture(tex.baseTexture, new PIXI.Rectangle(f.x, f.y + top + y, f.width, h)));
        band.y = top + y;
        band.alpha = UNDER_ALPHA * (1 - (i / UNDER_BANDS));
        u.addChild(band);
      }
      canvas.primary.addChild(u);
      rec.under = u;
      rec.underKey = key;
      rec.underTint = null;
    }

    const u = rec.under;
    // Laid exactly over the mesh: same place, size, mirror and sink.
    u.position.copyFrom(mesh.position);
    u.scale.copyFrom(mesh.scale);
    u.pivot.set(mesh.anchor.x * f.width, (mesh.anchor.y * f.height) + mesh.pivot.y);
    u.elevation = token.document.elevation ?? 0;
    u.sortLayer = mesh.sortLayer;
    u.sort = (mesh.sort ?? 0) + 0.1;
    u.visible = mesh.visible && mesh.renderable !== false;
    if (Number.isFinite(color) && rec.underTint !== color) {
      for (const band of u.children) band.tint = color;
      rec.underTint = color;
    }
  }

  function wade(token, dt) {
    const mesh = token.mesh;
    const doc = token.document;
    if (!mesh || mesh.destroyed || !doc || doc.hidden && !game.user.isGM) { release(token.id); return; }
    if (doc.getFlag?.(MODULE_ID, "pose")) { release(token.id); return; }   // bathers and posed: sprite-facing draws them

    const feet = { x: token.x + (token.w / 2), y: token.y + (token.h * 0.85) };
    const water = waterAt(feet, doc.elevation ?? 0);
    let rec = state.tokens.get(token.id);
    if (!water && !rec) return;
    if (!rec) {
      rec = { d: 0, target: 0, regionId: null, mask: null, under: null, underKey: null, waterline: null };
      state.tokens.set(token.id, rec);
    }
    if (water) { rec.target = water.depth; rec.regionId = water.regionId; }
    else rec.target = 0;

    // Ease toward the target depth.
    const step = (dt / EASE_MS) * Math.max(rec.target, rec.d, 0.1);
    rec.d = rec.d < rec.target ? Math.min(rec.target, rec.d + step) : Math.max(rec.target, rec.d - step);
    if (rec.d <= 0.001 && rec.target === 0) { release(token.id); return; }

    // The waterline is where the sprite's bottom (the feet) is when not sunk.
    const h = Math.abs(mesh.height), w = Math.abs(mesh.width);
    const sy = Math.abs(mesh.scale.y) || 1;
    const sinkWorld = rec.d * h;
    mesh.pivot.y = -sinkWorld / sy;
    const cx = mesh.x + ((0.5 - mesh.anchor.x) * w * Math.sign(mesh.scale.x || 1));
    const wy = mesh.y + ((1 - mesh.anchor.y) * h);
    rec.waterline = { cx, wy, w, depth: rec.d, full: rec.target || rec.d, regionId: rec.regionId };

    // Hide everything below the waterline.
    if (!rec.mask || rec.mask.destroyed) {
      rec.mask = new PIXI.Graphics();
      ensureMaskLayer().addChild(rec.mask);
    }
    rec.mask.clear().beginFill(0xffffff, 1).drawRect(cx - w, wy - (h * 4), w * 2, h * 4).endFill();
    if (mesh.mask !== rec.mask) mesh.mask = rec.mask;

    const color = window.oni?.PoseBathFx?.colorsFor?.(rec.regionId)?.base;
    holdUnder(token, rec, sinkWorld / sy, color);
  }

  function tick() {
    if (!state.active || !canvas?.ready) return;
    try {
      const now = performance.now();
      const dt = state.lastFrame ? Math.min(100, now - state.lastFrame) : 16;
      state.lastFrame = now;
      if (!waterRegions().length && !state.tokens.size) return;
      const seen = new Set();
      for (const token of canvas.tokens?.placeables ?? []) { seen.add(token.id); wade(token, dt); }
      for (const id of [...state.tokens.keys()]) if (!seen.has(id)) release(id);
    } catch (e) {
      const now = Date.now();
      if (now - (state.lastWarnAt ?? 0) > 5000) { state.lastWarnAt = now; console.warn(INSTALL_TAG, "Wading update failed.", e); }
    }
  }

  function start() {
    stop();
    state.active = sceneWades(canvas?.scene);
    if (!state.active || !canvas?.app?.ticker) return;
    state.tickerFn = tick;
    state.lastFrame = 0;
    // After sprite-facing (LOW) has put the walk art on, before the ripples (LOW - 2).
    canvas.app.ticker.add(state.tickerFn, null, PIXI.UPDATE_PRIORITY.LOW - 1);
  }

  function stop() {
    if (state.tickerFn && canvas?.app?.ticker) canvas.app.ticker.remove(state.tickerFn);
    state.tickerFn = null;
    for (const id of [...state.tokens.keys()]) release(id);
    try { state.maskLayer?.destroy({ children: true }); } catch (_) {}
    state.maskLayer = null;
    state.active = false;
  }

  Hooks.on("canvasReady", start);
  Hooks.on("canvasTearDown", stop);
  Hooks.on("updateScene", (scene) => { if (canvas?.scene && scene.id === canvas.scene.id && sceneWades(scene) !== state.active) start(); });
  Hooks.on("deleteToken", (doc) => release(doc.id));
  Hooks.once("ready", () => { if (canvas?.ready) start(); });

  window.oni.WaterWade = {
    installed: true,
    state,
    WATER_FLAG,
    waterOf, waterRegions, waterAt,
    // For the ripples: { cx, wy, w, depth, full, regionId } of a wading token, or null.
    waterlineOf: (tokenId) => state.tokens.get(tokenId)?.waterline ?? null
  };

  console.debug(INSTALL_TAG, "Installed. API: window.oni.WaterWade");
})();
