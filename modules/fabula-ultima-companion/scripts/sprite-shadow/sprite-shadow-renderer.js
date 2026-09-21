// ============================================================================
// FabulaUltimaCompanion — Sprite Shadow (renderer)
// File: scripts/sprite-shadow/sprite-shadow-renderer.js
// Foundry VTT v12
//
// Draws a soft black ground shadow under the sprite of every token whose actor
// has the `spriteShadow` flag on (see sprite-shadow-config.js). Pure
// presentation, client-local, no document writes.
//
// WHERE IT LIVES: the token's sprite is NOT a child of the Token placeable —
// `token.mesh` is a PrimarySpriteMesh inside `canvas.primary`, and the whole
// tokens layer renders ABOVE that group. A shadow parented to the token would
// therefore paint over the sprite. So each shadow is a plain PIXI.Sprite added
// to `canvas.primary`, given the same `elevation` / `sortLayer` as its mesh
// and `sort = mesh.sort - 0.5`, which the group's comparator reads via
// `(a.sort || 0)` — strictly under its own sprite, still above lower-sorted
// neighbours. The group only calls `updateCanvasTransform?.()` on children,
// so a non-PrimaryCanvasObject child is safe.
//
// WHAT SHAPE: a composite, baked ONCE per sprite texture into a RenderTexture
// (cached on the base texture) and drawn as a single sprite:
//
//   1. BODY ELLIPSE — the convention of the older bestiary art, whose shadows
//      are painted in. Its width comes from a column profile of the silhouette
//      (Foundry's cached alpha map, `TextureLoader.getTextureAlphaData`): a
//      column counts when it is ≥ `heightFrac` as tall as the tallest column
//      AND holds ≥ `groundMassFrac` of the peak mass in the bottom `groundFrac`
//      of the body. Blades, tridents and raised arms fail one of the two; body,
//      dress and blob pass both. Calibrated on the painted shadows (Asura 151 px
//      → 151, Gigas 100 → 95, Wraith 110 → 108).
//   2. GROUNDED PARTS — the sprite's OWN lower silhouette (that same bottom
//      `groundFrac` band) squashed by `squash` and centred on the ellipse. A
//      weapon resting on the floor, a tail, spread feet all live in that band
//      and so grow a thin sliver out of the ellipse; anything held high does
//      not reach the band and casts nothing. Toggle: `groundedParts`.
//
//   Both are drawn opaque black into the same texture (union, so the overlap
//   does not double), blurred by `blur` × ellipse width for the soft rim, and
//   the final sprite carries the single `alpha`. Texture-space rectangles go
//   through `mesh.toGlobal` → `canvas.primary.toLocal`, so anchor, scale,
//   mirroring and fit mode are handled by PIXI.
//
// LIFT — the one height channel. A shadow has a ground point and a `lift`
// (scene px the body is above it). Lift shrinks and fades the shadow
// (`liftScale` / `liftFade`, reached at lift = body height) but never moves it:
// the ground stays where the feet would land. Three things feed it:
//   • a `liftProvider` registered by sprite-shadow-airborne.js (Flying: hover
//     bias + the live TokenMagic bob), polled per frame for live tokens;
//   • `clone.lift` on an animation clone (see below), set by the script;
//   • nothing → 0, the grounded shadow.
//
// CLONES — skill animations never move `token.mesh`: every authored script
// hides the token (`oni.hideToken`) and tweens a throw-away sprite
// (`oni.cloneToken`). So the real shadow hides with the mesh, and
// `attachClone(spr, token)` gives the clone its own shadow — same bake, inserted
// just below the clone in the clone's parent, following it every frame with
// ground = clone.y + clone.lift. Default lift 0 makes the shadow ride with the
// clone exactly as a painted-in shadow would, so existing scripts see no
// behaviour change other than gaining a shadow; a script that jumps sets
// `clone.lift = h` (and draws the body at groundY - h) to get a true jump shadow.
// The clone shadow stays hidden while the source mesh is still visible (an
// afterimage clone next to a live token must not double the shadow).
//
// LIFECYCLE: refreshToken (position/state/alpha, also per animation frame),
// drawToken, destroyToken, updateActor (the flag flipped → resync that
// actor's tokens), canvasReady / canvasTearDown (the primary group is rebuilt
// with the scene, taking our sprites with it). Bakes are keyed on the STYLE
// snapshot, so live tuning rebuilds them on the next sync.
//
//   FUCompanion.api.spriteShadow.style     — live-tunable numbers (see STYLE)
//   FUCompanion.api.spriteShadow.refresh() — resync every token on the canvas
// ============================================================================

import { tokenCastsSpriteShadow, baseActorOf } from "./sprite-shadow-config.js";

const MODULE_ID = "fabula-ultima-companion";
const FLAG_PATH = `flags.${MODULE_ID}.spriteShadow`;
const TAG = "[FUC][SpriteShadow][render]";
const warn = (...a) => console.warn(TAG, ...a);

/** Tunable look. Exposed on the API so it can be dialled in live. */
export const STYLE = {
  alpha: 0.45,          // baked art measures 60–95/255; user asked for a touch stronger
  heightFrac: 0.25,     // column counts if its silhouette height ≥ this × tallest column …
  groundFrac: 0.4,      // … AND, within the bottom this-fraction of the body …
  groundMassFrac: 0.2,  // … it holds ≥ this × the peak per-column mass there
  widthFactor: 1.0,     // ellipse width = shape span × this
  minBodyFrac: 0.25,    // safety floor: never narrower than this × full body width
  aspect: 0.56,         // ellipse height / width …
  maxHeightFrac: 0.3,   // … but never taller than this × body height (a low, long body is wide, not deep)
  centerLift: 0.4,      // ellipse centre sits this × height ABOVE the foot line
  groundedParts: true,  // add the squashed lower silhouette (weapons resting on the floor, tails)
  squash: 0.5,          // vertical scale of that lower silhouette
  blur: 0.02,           // blur radius = this × ellipse width (soft rim; PIXI strength compounds per pass, keep small)
  opaque: 128,          // alpha threshold (0–255) for "body" pixels
  liftScale: 0.35,      // at lift = body height the shadow is (1 - this) × size …
  liftFade: 0.45,       // … and (1 - this) × alpha; both clamp at lift = body height
};

const _shadows = new Map();   // token.id -> PIXI.Sprite
const _geom = new WeakMap();  // TextureAlphaData -> derived geometry (texture px)
const _bakes = new WeakMap(); // BaseTexture -> { key, rt, x0, y0, w, h }

const styleKey = () => JSON.stringify(STYLE);

// Lift → size/alpha multipliers. `bodyH` in the same units as `lift`.
function liftFactors(lift, bodyH) {
  const k = bodyH > 0 ? Math.min(1, Math.max(0, lift / bodyH)) : 0;
  return { scale: 1 - STYLE.liftScale * k, alpha: 1 - STYLE.liftFade * k };
}

// Height providers for LIVE tokens (Flying etc.): fn(token) -> lift px or 0.
const _liftProviders = new Set();
export function registerLiftProvider(fn) { _liftProviders.add(fn); return () => _liftProviders.delete(fn); }
function liftFor(token) {
  let lift = 0;
  for (const fn of _liftProviders) { try { lift += Number(fn(token)) || 0; } catch (_) {} }
  return lift;
}

// ---------------------------------------------------------------------------
// Geometry from the alpha map (texture space, cached per alpha-data object)
// ---------------------------------------------------------------------------
function bodyGeometry(texture) {
  const ad = TextureLoader.getTextureAlphaData(texture, 0.25);
  if (!ad || ad.maxX <= ad.minX || ad.maxY <= ad.minY) return null;
  let g = _geom.get(ad);
  if (g && g.key === styleKey()) return g;

  const W = ad.maxX - ad.minX, H = ad.maxY - ad.minY, data = ad.data, T = STYLE.opaque;
  let bx0 = W, bx1 = -1, by0 = H, by1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (data[row + x] < T) continue;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  }
  if (bx1 < 0) return null; // nothing opaque

  // Column profile of the silhouette: total opaque height per column, and the
  // opaque count inside the ground band (bottom `groundFrac` of the body).
  const colH = new Uint16Array(W), colG = new Uint16Array(W);
  const groundTop = by1 - Math.max(1, Math.round((by1 - by0 + 1) * STYLE.groundFrac)) + 1;
  for (let y = by0; y <= by1; y++) {
    const row = y * W, inGround = y >= groundTop;
    for (let x = bx0; x <= bx1; x++) {
      if (data[row + x] < T) continue;
      colH[x]++;
      if (inGround) colG[x]++;
    }
  }
  let maxH = 0, maxG = 0;
  for (let x = bx0; x <= bx1; x++) { if (colH[x] > maxH) maxH = colH[x]; if (colG[x] > maxG) maxG = colG[x]; }
  const hMin = maxH * STYLE.heightFrac, gMin = maxG * STYLE.groundMassFrac;
  let sx0 = W, sx1 = -1;
  for (let x = bx0; x <= bx1; x++) {
    if (colH[x] < hMin || colG[x] < gMin) continue;
    if (x < sx0) sx0 = x;
    if (x > sx1) sx1 = x;
  }
  if (sx1 < 0) { sx0 = bx0; sx1 = bx1; } // degenerate — fall back to the body bbox

  // alpha-map px -> texture px
  const sx = texture.width / ad.width, sy = texture.height / ad.height;
  const bodyX0 = (ad.minX + bx0) * sx, bodyX1 = (ad.minX + bx1 + 1) * sx;
  const shapeX0 = (ad.minX + sx0) * sx, shapeX1 = (ad.minX + sx1 + 1) * sx;
  const footY = (ad.minY + by1 + 1) * sy;
  const groundTopY = (ad.minY + groundTop) * sy;
  // Ellipse in texture px.
  const w = Math.max((bodyX1 - bodyX0) * STYLE.minBodyFrac, (shapeX1 - shapeX0) * STYLE.widthFactor);
  const bodyH = (by1 - by0 + 1) * sy;
  const h = Math.min(w * STYLE.aspect, bodyH * STYLE.maxHeightFrac);
  g = { key: styleKey(), bodyX0, bodyX1, shapeX0, shapeX1, footY, groundTopY, bodyH,
        ell: { cx: (shapeX0 + shapeX1) / 2, cy: footY - h * STYLE.centerLift, w, h } };
  _geom.set(ad, g);
  return g;
}

// ---------------------------------------------------------------------------
// Bake: ellipse ∪ squashed lower silhouette → one RenderTexture per sprite
// ---------------------------------------------------------------------------
function bake(texture, g) {
  const base = texture.baseTexture;
  let b = _bakes.get(base);
  if (b && b.key === g.key && !b.rt.baseTexture?.destroyed) return b;
  if (b) { try { b.rt.destroy(true); } catch (_) {} }

  const { cx, cy, w, h } = g.ell;
  const bandH = Math.max(0, g.footY - g.groundTopY);
  const sq = STYLE.groundedParts ? STYLE.squash : 0;
  const blur = Math.max(1, w * STYLE.blur);
  const pad = Math.ceil(blur * 3) + 2;
  // Texture-space rectangle the bake covers.
  const x0 = Math.floor(Math.min(cx - w / 2, 0) - pad);
  const x1 = Math.ceil(Math.max(cx + w / 2, texture.width) + pad);
  const y0 = Math.floor(Math.min(cy - h / 2, cy - bandH * sq / 2) - pad);
  const y1 = Math.ceil(Math.max(cy + h / 2, cy + bandH * sq / 2) + pad);
  const W = x1 - x0, H = y1 - y0;

  const root = new PIXI.Container();
  root.addChild(new PIXI.Graphics().beginFill(0x000000).drawEllipse(cx - x0, cy - y0, w / 2, h / 2).endFill());
  if (sq > 0 && bandH > 0) {
    // The sprite's own lower band, black, squashed, centred on the ellipse.
    const f = texture.frame;
    const frame = new PIXI.Rectangle(f.x, f.y + Math.round(g.groundTopY), f.width, Math.round(bandH));
    const band = new PIXI.Sprite(new PIXI.Texture(base, frame));
    band.tint = 0x000000;
    band.scale.set(1, sq);
    band.position.set(0 - x0, cy - (bandH * sq) / 2 - y0);
    root.addChild(band);
  }
  root.filters = [new PIXI.BlurFilter(blur, 2)];
  root.filterArea = new PIXI.Rectangle(0, 0, W, H);

  const rt = PIXI.RenderTexture.create({ width: W, height: H, resolution: 1 });
  canvas.app.renderer.render(root, { renderTexture: rt, clear: true });
  root.destroy({ children: true, texture: false, baseTexture: false });

  b = { key: g.key, rt, x0, y0, w: W, h: H };
  _bakes.set(base, b);
  return b;
}

// ---------------------------------------------------------------------------
// Per-token sync
// ---------------------------------------------------------------------------
function removeShadow(tokenId) {
  const s = _shadows.get(tokenId);
  if (!s) return;
  _shadows.delete(tokenId);
  try { if (!s.destroyed) s.destroy({ texture: false, baseTexture: false }); } catch (e) { warn("destroy failed", e); }
}

function wantsShadow(token) {
  return !!(token?.mesh && !token.destroyed && token.mesh.texture?.valid && tokenCastsSpriteShadow(token));
}

const _pt = new PIXI.Point();
function texToPrimary(mesh, tex, x, y) {
  // SpriteMesh local space = texture px offset by the anchor (width/height are applied as scale).
  _pt.set(x - tex.width * mesh.anchor.x, y - tex.height * mesh.anchor.y);
  return canvas.primary.toLocal(mesh.toGlobal(_pt));
}

export function syncToken(token) {
  try {
    if (!canvas?.ready || !canvas.primary) return;
    if (!wantsShadow(token)) { removeShadow(token.id); return; }
    const mesh = token.mesh, tex = mesh.texture;
    const g = bodyGeometry(tex);
    if (!g) { removeShadow(token.id); return; }
    const b = bake(tex, g);

    let s = _shadows.get(token.id);
    if (!s || s.destroyed || s.parent !== canvas.primary) {
      if (s && !s.destroyed) s.destroy({ texture: false, baseTexture: false });
      s = new PIXI.Sprite(b.rt);
      s.anchor.set(0.5, 0.5);
      s.name = `fud-sprite-shadow:${token.id}`;
      s.eventMode = "none";
      canvas.primary.addChild(s);
      _shadows.set(token.id, s);
    }
    if (s.texture !== b.rt) s.texture = b.rt;

    // Place the baked rectangle in primary (scene) space.
    const tl = texToPrimary(mesh, tex, b.x0, b.y0); const tlx = tl.x, tly = tl.y;
    const br = texToPrimary(mesh, tex, b.x0 + b.w, b.y0 + b.h);
    const k = Math.abs(br.x - tlx) / b.w;
    const ec = texToPrimary(mesh, tex, g.ell.cx, g.ell.cy);
    // Base (lift 0) placement; applyLift() derives the drawn size/alpha from it.
    s.fudBase = {
      cx: (tlx + br.x) / 2, cy: (tly + br.y) / 2, w: Math.abs(br.x - tlx), h: Math.abs(br.y - tly),
      mirrored: br.x < tlx, bodyH: g.bodyH * k,
      alpha: STYLE.alpha * mesh.alpha * (mesh.hidden ? 0.5 : 1),
    };
    // Ellipse footprint in scene px, for probes/tests.
    s.fudShadow = { cx: ec.x, cy: ec.y, w: g.ell.w * k, h: g.ell.h * k };
    s.fudToken = token;
    applyLift(s, liftFor(token));

    // Depth: same elevation/layer as the sprite, a hair below it in sort.
    const sortChanged = s.elevation !== mesh.elevation || s.sort !== mesh.sort - 0.5 || s.sortLayer !== mesh.sortLayer || s.zIndex !== mesh.zIndex;
    s.elevation = mesh.elevation;
    s.sortLayer = mesh.sortLayer;
    s.sort = mesh.sort - 0.5;
    s.zIndex = mesh.zIndex;
    if (sortChanged) canvas.primary.sortDirty = true;

    // Visibility mirrors the sprite (hidden tokens render at half alpha for the GM).
    s.visible = token.visible && mesh.visible;
    s.renderable = mesh.renderable;
  } catch (e) {
    warn("syncToken failed", token?.name, e);
  }
}

/** Draw `s` from its base placement at the given lift (scene px above ground). */
function applyLift(s, lift) {
  const b = s.fudBase; if (!b) return;
  const f = liftFactors(lift, b.bodyH);
  s.fudLift = lift;
  s.position.set(b.cx, b.cy);
  s.width = b.w * f.scale;
  s.height = b.h * f.scale;
  if (b.mirrored) s.scale.x = -Math.abs(s.scale.x);
  s.alpha = b.alpha * f.alpha;
}

// Per-frame: live-token shadows follow their lift providers (a hovering body
// bobs every frame with no refreshToken), clone shadows follow their clone.
const _clones = new Set();
function onTick() {
  for (const s of _shadows.values()) {
    const t = s.fudToken;
    if (!t || t.destroyed || !s.fudBase) continue;
    // Visibility every frame, not only on refreshToken: oni.hideToken flips
    // mesh.renderable directly (and re-asserts it per tick) without a refresh,
    // and a stale real shadow under a lifted clone shadow reads as two shadows.
    const m = t.mesh;
    if (m) {
      const vis = t.visible && m.visible;
      if (s.visible !== vis) s.visible = vis;
      if (s.renderable !== m.renderable) s.renderable = m.renderable;
    }
    const lift = liftFor(t);
    if (lift !== s.fudLift) applyLift(s, lift);
  }
  for (const c of _clones) c.tick();
}

/**
 * Give an animation clone (a PIXI.Sprite of a token's mesh texture, anchor 0.5,
 * positioned in scene px) its own ground shadow. Returns a detach fn, or null
 * when the token's actor has the shadow off / the texture has no body.
 * The clone's `lift` property (scene px, default 0) is honoured every frame.
 */
export function attachClone(spr, token, { track } = {}) {
  try {
    if (!spr || spr.destroyed || !token?.actor || !tokenCastsSpriteShadow(token)) return null;
    const tex = spr.texture; if (!tex?.valid) return null;
    const g = bodyGeometry(tex); if (!g) return null;
    const b = bake(tex, g);
    const sh = new PIXI.Sprite(b.rt);
    sh.anchor.set(0.5, 0.5);
    sh.name = `fud-clone-shadow:${token.id}`;
    sh.eventMode = "none";
    sh.fudClone = spr;
    if (typeof spr.lift !== "number") spr.lift = 0;
    const srcMesh = token.mesh;
    let detached = false;
    const detach = () => {
      if (detached) return; detached = true;
      _clones.delete(entry);
      try { if (!sh.destroyed) sh.destroy({ texture: false, baseTexture: false }); } catch (_) {}
    };
    const entry = { tick() {
      if (spr.destroyed || sh.destroyed) { detach(); return; }
      const parent = spr.parent;
      if (!parent) { sh.visible = false; return; }
      // Keep the shadow immediately below the clone in its parent.
      if (sh.parent !== parent || parent.getChildIndex(sh) !== parent.getChildIndex(spr) - 1) {
        if (sh.parent) sh.parent.removeChild(sh);
        parent.addChildAt(sh, parent.getChildIndex(spr));
      }
      const sx = spr.scale.x, sy = spr.scale.y, ax = spr.anchor?.x ?? 0.5, ay = spr.anchor?.y ?? 0.5;
      const lift = Number(spr.lift) || 0;
      const f = liftFactors(lift, g.bodyH * Math.abs(sy));
      // Bake rect centre in the clone's parent space, ignoring the clone's rotation
      // (a tumbling body's shadow stays flat on the ground), pushed down by lift.
      sh.position.set(
        spr.x + (b.x0 + b.w / 2 - tex.width * ax) * sx,
        spr.y + (b.y0 + b.h / 2 - tex.height * ay) * sy + lift,
      );
      sh.width = b.w * Math.abs(sx) * f.scale;
      sh.height = b.h * Math.abs(sy) * f.scale;
      if (sx < 0) sh.scale.x = -Math.abs(sh.scale.x);
      sh.alpha = STYLE.alpha * spr.alpha * f.alpha;
      // No double shadow: only show while the source mesh is hidden (or gone).
      const srcVisible = !!(srcMesh && !srcMesh.destroyed && srcMesh.renderable && srcMesh.visible && token.visible);
      sh.visible = spr.visible && spr.renderable && !srcVisible;
    } };
    _clones.add(entry);
    spr.once?.("destroyed", detach);
    if (typeof track === "function") track(detach);
    entry.tick();
    return detach;
  } catch (e) {
    warn("attachClone failed", token?.name, e);
    return null;
  }
}

export function refreshAll() {
  if (!canvas?.ready) return;
  const live = new Set();
  for (const t of canvas.tokens?.placeables ?? []) { live.add(t.id); syncToken(t); }
  for (const id of [..._shadows.keys()]) if (!live.has(id)) removeShadow(id);
}

function clearAll() {
  for (const id of [..._shadows.keys()]) removeShadow(id);
  _shadows.clear();
  for (const c of [..._clones]) { try { c.tick(); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
Hooks.on("refreshToken", (token) => syncToken(token));
Hooks.on("drawToken", (token) => syncToken(token));
Hooks.on("destroyToken", (token) => removeShadow(token.id));
Hooks.on("canvasTearDown", clearAll);
Hooks.on("canvasReady", () => { clearAll(); refreshAll(); });
Hooks.on("updateActor", (actor, changes) => {
  const flagged = foundry.utils.hasProperty(changes, FLAG_PATH)
    || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=spriteShadow`)
    || foundry.utils.hasProperty(changes, "flags.-=" + MODULE_ID);
  if (!flagged || !canvas?.ready) return;
  for (const t of canvas.tokens.placeables) if (baseActorOf(t) === actor) syncToken(t);
});

Hooks.once("ready", () => {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  const api = (globalThis.FUCompanion.api.spriteShadow ||= {});
  api.style = STYLE;
  api.refresh = refreshAll;
  api.sync = syncToken;
  api.count = () => _shadows.size;
  api.attachClone = attachClone;
  api.registerLiftProvider = registerLiftProvider;
  api.liftFor = liftFor;
  // Priority -10: after every NORMAL-priority tween (oni.tween, TokenMagic
  // animations) has moved its sprite this frame, before the LOW-priority render
  // — so a clone shadow never trails its clone by a frame.
  const TICK_PRIORITY = -10;
  canvas?.app?.ticker?.add(onTick, undefined, TICK_PRIORITY);
  Hooks.on("canvasReady", () => { try { canvas.app.ticker.remove(onTick); canvas.app.ticker.add(onTick, undefined, TICK_PRIORITY); } catch (_) {} });
  if (canvas?.ready) refreshAll();
});
