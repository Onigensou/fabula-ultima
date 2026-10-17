/**
 * foreground-occluder.js
 * Fabula Ultima Companion - Foreground Occluders (walk behind roofs, wells, fences)
 * Foundry VTT v12
 *
 * Purpose:
 * - On a painted map, a token whose feet are BEHIND an object (house, well,
 *   fence...) is covered by that object, pixel by pixel, the way a JRPG draws
 *   its sprites behind foreground art.
 *
 * How it works (read before changing anything here):
 * - The map is one flat image, so depth comes from authored data: for every
 *   object pixel, the scene y of the ground it stands on ("ground line").
 *   A token is behind that pixel when the pixel's ground line is lower on the
 *   map (larger y) than the token's feet.
 * - The data is made offline by the Map Occluder tool (E:\...\Resource\Map
 *   Occluder): Segment Anything cuts each object out of the map and splits it
 *   into parts (logs, wall, roof...); each part gets its own ground line.
 *   It is stored on the scene, in IMAGE pixels, see "Storage" below.
 * - Each token near an object gets ONE overlay sprite made of the map's own
 *   pixels, opaque only where an object pixel is in front of that token's
 *   feet, drawn right above the token (token sort + 0.5). Painting the map
 *   back over the token IS the occlusion; several tokens around one object
 *   stay consistent because each overlay sits directly above its own token.
 * - A token with less than FRAG_HIDE of its body still showing is hidden
 *   completely (and its sprite shadow), so nobody is left as a sliver.
 * - Silhouette (per-scene switch, party token only): the covered part of the
 *   party sprite is drawn again as a pale-blue silhouette ON the object, so
 *   players never lose their character. Its mask is the overlay's own opaque
 *   area (a white copy of it, see below), so it matches the occlusion pixel
 *   for pixel; it keeps showing when the fragment rule hides the token.
 *
 * Client-local and purely visual: no document writes, nothing synced.
 *
 * TRAPS (each one cost a debugging round, 2026-10-15):
 * - A PIXI ticker callback that THROWS stops PIXI's whole frame loop: the
 *   canvas freezes while DOM buttons keep working. The per-frame step is
 *   wrapped and can never throw.
 * - Resizing a canvas-backed texture in place throws "frame does not fit
 *   inside the base Texture". A size change gets a brand-new canvas+texture.
 * - Reading pixels back from a VIDEO texture (walk animations) returns an
 *   empty image. Overlay visibility never depends on reading the sprite; the
 *   body shape falls back to the token's standing art.
 * - PIXI 7 sprite masks multiply by the mask's RED channel: masking with the
 *   coloured overlay leaves the silhouette almost invisible, so the mask is a
 *   separate white image.
 * - A sprite's own alpha is applied BEFORE its filters: fading with
 *   sprite.alpha and then cutting soft pixels (the shadow oval baked into the
 *   walk art) with a colour matrix removes the whole body. Cut first, fade in
 *   a second filter.
 *
 * Storage (scene flags):
 *   flags.<module>.oniFabula.general.occludersEnabled  boolean  per-scene switch (Scene Config)
 *   flags.<module>.oniFabula.general.occluderSilhouette boolean  party silhouette (Scene Config)
 *   flags.<module>.occluders = {
 *     v: 1,
 *     src:  background image path the data was made from (stale-data guard),
 *     w, h: that image's pixel size,
 *     objects: [{ id, box: [x, y, w, h], b64 }]   // b64 = deflate(Uint16 ground line per box pixel, 0 = none)
 *   }
 *
 * Globals:
 *   globalThis.__ONI_FOREGROUND_OCCLUDER__
 *
 * API:
 *   FUCompanion.api.ForegroundOccluder
 */

(() => {
  const GLOBAL_KEY = "__ONI_FOREGROUND_OCCLUDER__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const FABULA_ROOT_KEY = "oniFabula";
  const GENERAL_KEY = "general";
  const ENABLED_KEY = "occludersEnabled";
  const SILHOUETTE_KEY = "occluderSilhouette";
  const DATA_KEY = "occluders";
  const DATA_VERSION = 1;

  const FRAG_HIDE = 0.15;      // hide a token showing less than this much of its body
  const FRAG_SHOW = 0.20;      // ... and show it again above this (no flicker at the edge)
  const SOLID_ALPHA = 160;     // sprite pixels at or above this alpha count as body
  const PAD = 2;               // overlay margin around the token's drawn sprite (image px)

  // Silhouette look: pale blue at 62%. The alpha row (4a - 2.4) drops the soft,
  // half-transparent shadow oval baked into the walk art and keeps the body.
  const SIL_COLOR = [0.55, 0.8, 1.0];
  const SIL_ALPHA = 0.62;
  const SIL_ALPHA_CUT = [4, -2.4];

  const TAG = "[ONI][Occluder]";
  const DEBUG_KEY = "ONI_OCCLUDER_DEBUG";
  if (globalThis[DEBUG_KEY] === undefined) globalThis[DEBUG_KEY] = false;
  const dbg  = (...a) => { if (globalThis[DEBUG_KEY]) console.log(TAG, ...a); };
  const warn = (...a) => console.warn(TAG, ...a);

  // --------------------------------------------------------------------------
  // State for the scene on the canvas
  // --------------------------------------------------------------------------
  const state = {
    installed: false,
    sceneId: null,
    active: false,
    silhouette: false,       // scene switch, read on build
    reason: "not built",
    objects: [],             // { id, x, y, w, h, ground: Uint16Array, rgba: Uint8Array }
    img: null,               // { w, h, sx, sy, kx, ky }  image <-> scene mapping
    overlays: new Map(),     // tokenId -> overlay record
    hidden: new Set(),       // token ids hidden by the fragment rule
    alphaCache: new Map(),
    standTex: new Map(),
    buildSeq: 0,
    lastError: 0
  };

  const safeGet = (obj, path, fallback) => {
    try { const v = foundry.utils.getProperty(obj, path); return v === undefined ? fallback : v; }
    catch { return fallback; }
  };
  const cleanSrc = (s) => String(s ?? "").split("?")[0];

  // --------------------------------------------------------------------------
  // Build
  // --------------------------------------------------------------------------
  async function inflate(b64) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint16Array(await new Response(ds).arrayBuffer());
  }

  /** Read one box of the background image back as RGBA (image px). */
  function extractBox(bgTex, x, y, w, h) {
    const spr = new PIXI.Sprite(bgTex);
    spr.position.set(-x, -y);
    const holder = new PIXI.Container();
    holder.addChild(spr);
    const rt = PIXI.RenderTexture.create({ width: w, height: h, resolution: 1 });
    try {
      canvas.app.renderer.render(holder, { renderTexture: rt, clear: true });
      return canvas.app.renderer.extract.pixels(rt);
    } finally {
      holder.destroy({ children: true });
      rt.destroy(true);
    }
  }

  function readSceneSetup(scene) {
    if (!scene) return { ok: false, reason: "no scene" };
    const enabled = safeGet(scene.getFlag?.(MODULE_ID, FABULA_ROOT_KEY), `${GENERAL_KEY}.${ENABLED_KEY}`, false) === true;
    if (!enabled) return { ok: false, reason: "off for this scene" };
    const data = scene.getFlag?.(MODULE_ID, DATA_KEY);
    if (!data?.objects?.length) return { ok: false, reason: "no occluder data" };
    if (data.v !== DATA_VERSION) return { ok: false, reason: `data version ${data.v} (expected ${DATA_VERSION})` };
    if (cleanSrc(data.src) !== cleanSrc(scene.background?.src)) return { ok: false, reason: "stale: map image changed since the data was made", stale: true, data };
    return { ok: true, data };
  }

  async function build(reason = "build") {
    teardown("rebuild");
    const seq = ++state.buildSeq;
    const scene = canvas?.scene;
    state.sceneId = scene?.id ?? null;
    const setup = readSceneSetup(scene);
    if (!setup.ok) {
      state.reason = setup.reason;
      if (setup.stale && game.user?.isGM) {
        ui.notifications?.warn?.(`Foreground occluders are off on "${scene.name}": the map image changed since they were made. Re-run the Map Occluder tool.`);
      }
      dbg("not active", { scene: scene?.name, reason: setup.reason });
      return;
    }
    const data = setup.data;
    const bg = canvas.primary?.background;
    const bgTex = bg?.texture;
    if (!bgTex?.valid) { state.reason = "background texture not ready"; return; }
    if (bgTex.width !== data.w || bgTex.height !== data.h) {
      state.reason = `image size ${bgTex.width}x${bgTex.height} does not match data ${data.w}x${data.h}`;
      warn(state.reason);
      return;
    }

    const rect = canvas.dimensions.sceneRect;
    state.img = {
      w: data.w, h: data.h,
      sx: rect.x, sy: rect.y,
      kx: data.w / rect.width, ky: data.h / rect.height      // image px per scene px
    };

    const objects = [];
    for (const o of data.objects) {
      try {
        const ground = await inflate(o.b64);
        const [x, y, w, h] = o.box;
        if (ground.length !== w * h) { warn("object data size mismatch, skipped", o.id); continue; }
        const rgba = extractBox(bgTex, x, y, w, h);
        objects.push({ id: o.id, x, y, w, h, ground, rgba });
      } catch (e) {
        warn("object failed to load, skipped", o.id, e);
      }
      if (seq !== state.buildSeq) return;            // a newer build started (scene changed)
    }
    if (!objects.length) { state.reason = "no object loaded"; return; }

    state.objects = objects;
    state.silhouette = safeGet(scene.getFlag?.(MODULE_ID, FABULA_ROOT_KEY), `${GENERAL_KEY}.${SILHOUETTE_KEY}`, false) === true;
    state.active = true;
    state.reason = `active (${reason})`;
    canvas.app.ticker.add(tick, null, PIXI.UPDATE_PRIORITY.LOW);
    dbg("active", { scene: scene.name, objects: objects.length });
  }

  function teardown(reason = "teardown") {
    try { canvas?.app?.ticker?.remove(tick); } catch {}
    for (const id of [...state.overlays.keys()]) dropOverlay(id);
    for (const id of [...state.hidden]) {
      const t = canvas?.tokens?.get?.(id);
      if (t) setHidden(t, false); else state.hidden.delete(id);
    }
    for (const tex of state.standTex.values()) { try { tex.destroy(false); } catch {} }
    state.standTex.clear();
    state.alphaCache.clear();
    state.objects = [];
    state.active = false;
    state.reason = reason;
  }

  // --------------------------------------------------------------------------
  // Token body shape (for the fragment rule)
  // --------------------------------------------------------------------------
  function alphaOf(tex) {
    if (!tex?.valid) return null;
    const f = tex.frame, key = `${tex.baseTexture.uid}:${f.x},${f.y},${f.width},${f.height}`;
    const cached = state.alphaCache.get(key);
    if (cached) return cached;
    try {
      const spr = new PIXI.Sprite(tex);
      const px = canvas.app.renderer.extract.pixels(spr);
      const w = Math.round(spr.width), h = Math.round(spr.height);
      spr.destroy();
      const a = new Uint8Array(w * h);
      let solid = 0;
      for (let i = 0; i < w * h; i++) { a[i] = px[i * 4 + 3]; if (a[i] >= SOLID_ALPHA) solid++; }
      if (!solid) return null;                        // video frames read back empty: not cached
      const out = { w, h, a };
      state.alphaCache.set(key, out);
      return out;
    } catch {
      return null;
    }
  }

  /** Body shape of the sprite on screen, or of the token's standing art when it cannot be read. */
  function bodyAlpha(token) {
    const a = alphaOf(token.mesh.texture);
    if (a) return a;
    let st = state.standTex.get(token.id);
    const src = token.document?.texture?.src;
    if (!st && src) { st = PIXI.Texture.from(src); state.standTex.set(token.id, st); }
    return st?.valid ? alphaOf(st) : null;
  }

  // --------------------------------------------------------------------------
  // Per-token overlay
  // --------------------------------------------------------------------------
  function sceneRectOf(mesh) {
    const gb = mesh.getBounds(false);
    const wt = canvas.stage.worldTransform;
    const tl = wt.applyInverse({ x: gb.x, y: gb.y });
    const br = wt.applyInverse({ x: gb.x + gb.width, y: gb.y + gb.height });
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y, flipX: mesh.scale.x < 0 };
  }

  function newOverlay(tokenId) {
    const c = document.createElement("canvas");
    c.width = 4; c.height = 4;
    const tex = PIXI.Texture.from(c);
    const spr = new PrimarySpriteMesh({ texture: tex, name: `oniOccluderOverlay:${tokenId}` });
    spr.anchor.set(0, 0);
    spr.eventMode = "none";
    spr.elevation = 0;
    spr.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
    canvas.primary.addChild(spr);
    const rec = { spr, canvas: c, ctx: c.getContext("2d"), tex, key: "", cover: 0, painted: 0, sil: null };
    state.overlays.set(tokenId, rec);
    return rec;
  }

  function dropOverlay(tokenId) {
    const o = state.overlays.get(tokenId);
    if (!o) return;
    dropSilhouette(o);
    try { o.spr.destroy(); } catch {}
    try { o.tex.destroy(true); } catch {}
    state.overlays.delete(tokenId);
  }

  // --------------------------------------------------------------------------
  // Party silhouette
  // --------------------------------------------------------------------------
  /** The party token = the token of the movement system's central party actor. */
  function isPartyToken(token) {
    try {
      const snap = FUCompanion?.api?.MovementControl?.getLastSnapshot?.();
      const id = snap?.centralPartyActorId ?? null;
      return !!id && token.document?.actorId === id;
    } catch {
      return false;
    }
  }

  function newSilhouette() {
    const mc = document.createElement("canvas");
    mc.width = 4; mc.height = 4;
    const maskTex = PIXI.Texture.from(mc);
    const mask = new PIXI.Sprite(maskTex);
    mask.eventMode = "none";
    canvas.stage.addChild(mask);               // outside primary: its transform stays current

    const spr = new PIXI.Sprite(PIXI.Texture.EMPTY);
    spr.name = "oniOccluderSilhouette";
    spr.eventMode = "none";
    spr.elevation = 0;
    spr.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TOKENS;
    const tint = new PIXI.ColorMatrixFilter();
    const [r, g, b] = SIL_COLOR;
    tint.matrix = [0, 0, 0, 0, r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, SIL_ALPHA_CUT[0], SIL_ALPHA_CUT[1]];
    const fade = new PIXI.ColorMatrixFilter();
    fade.matrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, SIL_ALPHA, 0];
    spr.filters = [tint, fade];
    spr.mask = mask;
    canvas.primary.addChild(spr);
    return { spr, mask, maskCanvas: mc, maskCtx: mc.getContext("2d"), maskTex };
  }

  function dropSilhouette(o) {
    const s = o?.sil;
    if (!s) return;
    try { s.spr.mask = null; s.spr.destroy({ texture: false }); } catch {}
    try { s.mask.destroy(); } catch {}
    try { s.maskTex.destroy(true); } catch {}
    o.sil = null;
  }

  /** White copy of the overlay's opaque area, same size and place. */
  function paintSilhouetteMask(o, d, w, h, x, y, sw, sh) {
    const s = o.sil;
    if (s.maskCanvas.width !== w || s.maskCanvas.height !== h) {
      const mc = document.createElement("canvas");
      mc.width = w; mc.height = h;
      const old = s.maskTex;
      s.maskCanvas = mc; s.maskCtx = mc.getContext("2d"); s.maskTex = PIXI.Texture.from(mc);
      s.mask.texture = s.maskTex;
      old.destroy(true);
    }
    const img = s.maskCtx.createImageData(w, h), m = img.data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) { m[i - 3] = 255; m[i - 2] = 255; m[i - 1] = 255; m[i] = 255; }
    s.maskCtx.putImageData(img, 0, 0);
    s.maskTex.baseTexture.update();
    s.mask.position.set(x, y);
    s.mask.width = sw;
    s.mask.height = sh;
  }

  /** Follow the token's sprite every frame (walk video, facing flip, sway, depth scale). */
  function syncSilhouette(o, mesh) {
    const spr = o.sil.spr;
    if (spr.texture !== mesh.texture) spr.texture = mesh.texture;
    spr.anchor.copyFrom(mesh.anchor);
    spr.position.copyFrom(mesh.position);
    spr.scale.copyFrom(mesh.scale);
    spr.rotation = mesh.rotation;
    const sortKey = o.spr.sort + 0.1;
    if (spr.sort !== sortKey) spr.sort = sortKey;
  }

  function setHidden(token, on) {
    const shadow = canvas.primary?.children?.find(c => c.name === `fud-sprite-shadow:${token.id}`);
    if (token.mesh) token.mesh.renderable = !on;
    if (shadow) shadow.renderable = !on;
    if (on) state.hidden.add(token.id); else state.hidden.delete(token.id);
  }

  /** Ground line at an image pixel, 0 = no object there. Objects overlap: the nearer one wins. */
  function groundAtImg(ix, iy, list = state.objects) {
    let g = 0;
    for (const o of list) {
      const x = ix - o.x, y = iy - o.y;
      if (x < 0 || y < 0 || x >= o.w || y >= o.h) continue;
      const v = o.ground[y * o.w + x];
      if (v > g) g = v;
    }
    return g;
  }

  function colourAtImg(ix, iy, out, di, list = state.objects) {
    for (const o of list) {
      const x = ix - o.x, y = iy - o.y;
      if (x < 0 || y < 0 || x >= o.w || y >= o.h) continue;
      if (!o.ground[y * o.w + x]) continue;
      const si = (y * o.w + x) * 4;
      out[di] = o.rgba[si]; out[di + 1] = o.rgba[si + 1]; out[di + 2] = o.rgba[si + 2]; out[di + 3] = 255;
      return;
    }
  }

  function updateToken(token, seen) {
    const mesh = token.mesh;
    if (!mesh || !token.visible) return;
    const I = state.img;
    const R = sceneRectOf(mesh);
    // token rect in image px
    const ix0 = Math.max(0, Math.floor((R.x - I.sx) * I.kx) - PAD);
    const iy0 = Math.max(0, Math.floor((R.y - I.sy) * I.ky) - PAD);
    const ix1 = Math.min(I.w, Math.ceil((R.x + R.w - I.sx) * I.kx) + PAD);
    const iy1 = Math.min(I.h, Math.ceil((R.y + R.h - I.sy) * I.ky) + PAD);
    const w = ix1 - ix0, h = iy1 - iy0;
    if (w <= 0 || h <= 0) return;
    // only the objects overlapping this token are tested per pixel (towns have dozens)
    const near = state.objects.filter(o => ix1 > o.x && ix0 < o.x + o.w && iy1 > o.y && iy0 < o.y + o.h);
    if (!near.length) return;
    seen.add(token.id);

    // feet in image px (ground lines are stored in image px)
    const feet = ((token.document.y + token.h) - I.sy) * I.ky;
    const o = state.overlays.get(token.id) ?? newOverlay(token.id);
    const wantSil = state.silhouette && isPartyToken(token);
    if (wantSil && !o.sil) { o.sil = newSilhouette(); o.key = ""; }
    else if (!wantSil && o.sil) dropSilhouette(o);
    const key = `${ix0},${iy0},${w},${h},${Math.round(feet)},${mesh.texture?.baseTexture?.uid},${R.flipX},${near.length}`;

    if (o.key !== key) {
      o.key = key;
      if (o.canvas.width !== w || o.canvas.height !== h) {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const old = o.tex;
        o.canvas = c; o.ctx = c.getContext("2d"); o.tex = PIXI.Texture.from(c);
        o.spr.texture = o.tex;
        old.destroy(true);
      }
      const al = bodyAlpha(token);
      const img = o.ctx.createImageData(w, h), d = img.data;
      const rx = (R.x - I.sx) * I.kx, ry = (R.y - I.sy) * I.ky, rw = R.w * I.kx, rh = R.h * I.ky;
      let total = 0, covered = 0, painted = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const gx = ix0 + x, gy = iy0 + y;
        const on = groundAtImg(gx, gy, near) > feet;
        if (on) { painted++; colourAtImg(gx, gy, d, (y * w + x) * 4, near); }
        const u = (gx + 0.5 - rx) / rw, v = (gy + 0.5 - ry) / rh;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        if (al) {
          const ax = Math.min(al.w - 1, Math.floor((R.flipX ? 1 - u : u) * al.w));
          const ay = Math.min(al.h - 1, Math.floor(v * al.h));
          if (al.a[ay * al.w + ax] < SOLID_ALPHA) continue;
        }
        total++;
        if (on) covered++;
      }
      o.ctx.putImageData(img, 0, 0);
      o.tex.baseTexture.update();
      o.spr.position.set(I.sx + ix0 / I.kx, I.sy + iy0 / I.ky);
      o.spr.width = w / I.kx;
      o.spr.height = h / I.ky;
      if (o.sil) paintSilhouetteMask(o, d, w, h, o.spr.position.x, o.spr.position.y, w / I.kx, h / I.ky);
      o.cover = total ? covered / total : 0;
      o.painted = painted;
    }

    const sortKey = (mesh.sort ?? 0) + 0.5;
    if (o.spr.sort !== sortKey) o.spr.sort = sortKey;
    o.spr.visible = o.painted > 0;            // never depends on reading the sprite
    if (o.sil) {
      syncSilhouette(o, mesh);
      o.sil.spr.visible = o.painted > 0;
    }

    const visible = 1 - o.cover;
    if (!state.hidden.has(token.id) && visible < FRAG_HIDE) setHidden(token, true);
    else if (state.hidden.has(token.id) && visible > FRAG_SHOW) setHidden(token, false);
  }

  function tickInner() {
    const seen = new Set();
    for (const token of canvas.tokens?.placeables ?? []) updateToken(token, seen);
    for (const id of [...state.overlays.keys()]) {
      if (seen.has(id)) continue;
      dropOverlay(id);
      if (state.hidden.has(id)) {
        const t = canvas.tokens.get(id);
        if (t) setHidden(t, false); else state.hidden.delete(id);
      }
    }
  }

  // A ticker callback that throws stops PIXI's frame loop for good; this one never throws.
  function tick() {
    try { tickInner(); }
    catch (e) {
      const now = performance.now();
      if (now - state.lastError > 5000) { state.lastError = now; warn("tick failed (frame loop kept alive)", e); }
    }
  }

  // --------------------------------------------------------------------------
  // Hooks
  // --------------------------------------------------------------------------
  function scheduleBuild(reason) {
    build(reason).catch(e => { state.reason = `build failed: ${e?.message ?? e}`; warn("build failed", e); });
  }

  function installHooks() {
    Hooks.on("canvasReady", () => scheduleBuild("canvasReady"));
    Hooks.on("canvasTearDown", () => teardown("canvasTearDown"));
    Hooks.on("updateScene", (scene, changes) => {
      if (!canvas?.scene || scene.id !== canvas.scene.id) return;
      const touched = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${DATA_KEY}`)
        || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=${DATA_KEY}`)
        || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${ENABLED_KEY}`)
        || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FABULA_ROOT_KEY}.${GENERAL_KEY}.${SILHOUETTE_KEY}`);
      if (touched) scheduleBuild("updateScene");
    });
    Hooks.on("deleteToken", (doc) => { dropOverlay(doc.id); state.hidden.delete(doc.id); });
  }

  // --------------------------------------------------------------------------
  // API
  // --------------------------------------------------------------------------
  const api = {
    installed: true,
    KEYS: { MODULE_ID, FABULA_ROOT_KEY, GENERAL_KEY, ENABLED_KEY, SILHOUETTE_KEY, DATA_KEY, DATA_VERSION },
    status() {
      return {
        scene: canvas?.scene?.name ?? null,
        active: state.active,
        silhouette: state.silhouette,
        reason: state.reason,
        objects: state.objects.map(o => ({ id: o.id, box: [o.x, o.y, o.w, o.h] })),
        tokens: [...state.overlays.entries()].map(([id, o]) => ({
          id, name: canvas.tokens.get(id)?.name ?? null,
          cover: +o.cover.toFixed(2), hidden: state.hidden.has(id), silhouette: !!o.sil
        }))
      };
    },
    refresh: () => scheduleBuild("manual"),
    /** Client-only off switch for comparing with/without (does not change the scene). */
    disableLocal: () => teardown("disabled locally"),
    /** Ground line at a SCENE point (debug). */
    groundAt(x, y) {
      const I = state.img; if (!I) return 0;
      return groundAtImg(Math.round((x - I.sx) * I.kx), Math.round((y - I.sy) * I.ky));
    }
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.ForegroundOccluder = api;
    } catch (err) {
      warn("Failed to attach API to FUCompanion.api", err);
    }
    installHooks();
    state.installed = true;
    if (canvas?.ready) scheduleBuild("ready");
    dbg("foreground-occluder.js ready");
  });
})();
