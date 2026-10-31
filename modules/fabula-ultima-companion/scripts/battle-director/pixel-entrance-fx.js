// ============================================================================
// Pixel entrance FX — plays a pixel-art entrance (pixel-entrance-styles.js)
// for ONE creature on THIS client. The caller (director-init.js descendIn /
// playJoinOne) owns the order and the stagger.
//
// DENSITY: one effect pixel = one screen pixel at the scene's default battle
// view (the finest grid the party's own 1:1 pixel art survives at; measured
// 0.47 – 0.73 screen px per art px). The effect is drawn on a CPU frame at that
// density (pixelfx), uploaded as NEAREST textures each tick, and scaled with
// the camera like the sprites: it is never re-rasterised for a zoom.
//
// THE CREATURE: its silhouette for the effect is built from the token's own
// art at that density (bestiary PNGs carry a baked ground shadow, alpha
// 53 – 78: only alpha > 96 is creature). The creature itself is drawn by a
// copy of the token's mesh texture between the effect's back and front layers,
// faded in or raised out of the floor as the style's `reveal` says; the real
// token is held invisible (locally) and revealed at the end, under the layer.
// Nothing is written to any document.
//
// DEPTH: one container at the creature's own depth in `canvas.primary` (the
// token mesh's elevation / sortLayer / sort / zIndex, right after the mesh),
// the party-entrance-fx.js rule. Never an overlay above every token.
//
// 3D (hybrid, user 2026-10-31): under the battle 3D camera the container
// rides the camera's map of the creature (drawn where and as large as the
// camera draws it), so everything on its card stays upright and camera-facing;
// the floor parts (rings, the summoning circle, the dash's run path and
// streak) are laid on the floor the camera draws, through the camera's map of
// the floor at the creature's feet (pixel-entrance/floor.js). The dash comes
// from the floor direction drawn furthest behind the creature. With a flat
// camera every effect is the approved mockup exactly.
// ============================================================================

import { warn } from "./logger.js";
import { restViewFor } from "./director-camera.js";
import { shadowSpriteFor, STYLE as SHADOW_STYLE } from "../sprite-shadow/sprite-shadow-renderer.js";
import { PIXEL_ENTRANCE_STYLES, FRAME_PAD, fadeReveal, dashSpan } from "./pixel-entrance-styles.js";
import { createFrame, clearFrame, createFx } from "./pixel-entrance/pixelfx/core/index.js";
import { VOID } from "./pixel-entrance/pixelfx/fx/shadow/_lib.js";
import { makeFloor } from "./pixel-entrance/floor.js";
import * as voidDash from "./pixel-entrance/void-dash.js";
import * as blinkInHd from "./pixel-entrance/blink-in-hd.js";
import * as summonCircleHd from "./pixel-entrance/summon-circle-hd.js";

const MODULES = { "void-dash": voidDash, "blink-in-hd": blinkInHd, "summon-circle-hd": summonCircleHd };
const PALETTES = { VOID };

// An entrance gates the battle: it may never hold it longer than its own
// length plus this.
const FAILSAFE_MS = 2000;
// A client that receives the broadcast before its canvas has drawn the token
// waits this long for it.
const TOKEN_WAIT_MS = 1500;
// Art alpha above this is creature; below it, the baked ground shadow.
const MASK_ALPHA = 96;
// The dash's warning glint sits this many screen px inside the field's edge
// (clear of the left tool palette; the mockup's value).
const GLINT_INSET_PX = 80;
// The mockup's sand, for an arena whose floor cannot be sampled.
const SAND = ["#a8794a", "#c99a64", "#e2bd8a"];

export const isPixelEntranceStyle = (key) => Object.prototype.hasOwnProperty.call(PIXEL_ENTRANCE_STYLES, key);

/**
 * Play `style` for the token on this client. Resolves true when the creature
 * is standing on the field (token revealed), false when the style could not
 * play (the caller then falls back to the plain fade).
 *   { tokenId, style, sceneId, clock }
 * `clock` (optional) replaces performance.now() — for frame-exact captures.
 */
export function playPixelEntranceLocal({ tokenId, style, sceneId = null, clock = null } = {}) {
  return new Promise((resolve) => {
    const cfg = PIXEL_ENTRANCE_STYLES[style];
    if (!cfg || !MODULES[cfg.module] || typeof PIXI === "undefined" || !canvas?.ready) { resolve(false); return; }
    if (sceneId && canvas.scene?.id !== sceneId) { resolve(true); return; }
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const failsafe = clock ? null : setTimeout(() => {
      const t = canvas?.tokens?.get?.(tokenId);
      if (t) showToken(t);
      finish(true);
    }, cfg.totalMs + TOKEN_WAIT_MS + FAILSAFE_MS);
    waitForToken(tokenId)
      .then((token) => (token ? run(token, style, clock) : false))
      .then((ok) => finish(ok !== false))
      .catch((e) => {
        warn(`pixel-entrance: "${style}" threw`, e);
        const t = canvas?.tokens?.get?.(tokenId);
        if (t) showToken(t);
        finish(false);
      })
      .finally(() => clearTimeout(failsafe));
  });
}

async function waitForToken(tokenId) {
  const t0 = performance.now();
  for (;;) {
    const t = canvas?.tokens?.get?.(tokenId);
    if (t && !t.destroyed && t.mesh) return t;
    if (performance.now() - t0 > TOKEN_WAIT_MS) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/* ── Runner ─────────────────────────────────────────────────────────────── */

async function run(token, style, clock) {
  const cfg = PIXEL_ENTRANCE_STYLES[style];
  const mod = MODULES[cfg.module];
  const S3 = globalThis.__ONI_BATTLE_STAGE_3D__;
  hideToken(token);
  holdShadow(token, 0);

  const geo = meshGeometry(token);
  const art = tokenArt(token);
  if (!geo || !art) { showToken(token); holdShadow(token, 1); return false; }
  const D = densityFor(canvas.scene);   // effect px per scene px
  // Bestiary art faces left: a mirrored mesh faces right. The effect is drawn
  // facing right and mirrored as a whole when the creature faces left.
  const face = geo.flip < 0 ? 1 : -1;
  const body = buildActor(art, geo, D, face);
  if (!body) { showToken(token); holdShadow(token, 1); return false; }
  const A = body.actor;
  const feet = body.feet;   // 2D spot (scene px), the creature's bottom centre

  // Under a live 3D camera: the floor at the feet as the camera draws it.
  const map0 = S3?.drawnMap?.(token) ?? null;
  const floor = map0 ? floorMapAt(S3, feet, D, map0.m, face) : null;

  const o = { ...(mod.meta.options ?? {}), ...(cfg.options ?? {}), actor: A, floorDy: body.floorDy, floor };
  if (cfg.palette && PALETTES[cfg.palette]) o.palette = PALETTES[cfg.palette];
  if (cfg.arenaDust) o.dust = arenaDust(feet) ?? SAND;

  // the container: at the feet, effect px, riding the camera's map
  const root = new PIXI.Container();
  root.name = `fud-pixel-entrance:${token.id}`;
  root.eventMode = "none";
  const ride = () => {
    const map = S3?.drawnMap?.(token);
    if (map) {
      root.position.set(map.bx + (feet.x - map.fx) * map.m, map.by + (feet.y - map.fy) * map.m);
      root.scale.set(map.m / D);
    } else {
      root.position.set(feet.x, feet.y);
      root.scale.set(1 / D);
    }
  };
  ride();
  placeAtTokenDepth(root, token.mesh);

  if (cfg.module === "void-dash") Object.assign(o, dashOptions(root, A, o, face));

  const L = mod.layout ? mod.layout(o) : { size: mod.meta.size, origin: mod.meta.origin };
  const [w, h] = L.size.map((v) => Math.max(1, Math.ceil(v)) + 2 * FRAME_PAD);
  const [ox, oy] = L.origin.map((v) => v + FRAME_PAD);
  const fx = createFx(mod, { ...o, x: ox, y: oy });
  const frames = { back: createFrame(w, h), front: createFrame(w, h) };
  const layer = (frame) => {
    const c = new PIXI.Container();
    c.scale.x = face;
    const make = (buf, add) => {
      const tex = PIXI.Texture.fromBuffer(new Uint8Array(buf.buffer), w, h, {
        scaleMode: PIXI.SCALE_MODES.NEAREST, alphaMode: PIXI.ALPHA_MODES.UNPACK,
      });
      const s = new PIXI.Sprite(tex);
      s.position.set(-ox, -oy);
      if (add) s.blendMode = PIXI.BLEND_MODES.ADD;
      c.addChild(s);
      return s;
    };
    return { c, frame, color: make(frame.color, false), light: make(frame.light, true) };
  };
  const back = layer(frames.back), front = layer(frames.front);

  // the creature: a copy of the mesh, where the mesh is drawn on its 2D spot
  const creature = new PIXI.Sprite(token.mesh.texture);
  creature.anchor.set(0.5, 1);
  creature.width = geo.w * D;
  creature.height = geo.h * D;
  if (geo.flip < 0) creature.scale.x *= -1;
  const cx = (geo.x0 + geo.w / 2 - feet.x) * D, cy = (geo.y0 + geo.h - feet.y) * D;
  creature.position.set(cx, cy);
  creature.alpha = 0;
  // the feet line, for a creature rising out of the floor
  const clip = new PIXI.Graphics();
  clip.beginFill(0xffffff).drawRect(-8192, -8192, 16384, 8192 + 1).endFill();
  root.addChild(back.c, creature, clip, front.c);

  const upload = (L) => {
    try { L.color.texture.baseTexture.resource.update(); L.light.texture.baseTexture.resource.update(); } catch { /* gone */ }
  };
  const reveal = (t) => (cfg.reveal?.mode === "module" && mod.reveal ? mod.reveal(t) : fadeReveal(cfg.reveal, t)) ?? { a: 1, rise: 1, shadow: 1 };
  const now = clock ?? (() => performance.now());

  try {
    await new Promise((done) => {
      const t0 = now();
      let last = 0;
      const tick = () => {
        if (token.destroyed || root.destroyed) { done(); return; }
        const t = Math.max(0, (now() - t0) / 1000);
        if (t > last) { fx.update(t - last); last = t; }
        const tt = fx.t;
        hideToken(token);
        keepDepth(root, token.mesh);
        ride();
        const v = reveal(tt);
        holdShadow(token, clamp(v.shadow ?? v.a, 0, 1));
        creature.alpha = clamp(v.a, 0, 1);
        const rise = clamp(v.rise ?? 1, 0, 1);
        creature.y = cy + (1 - rise) * A.h;
        creature.mask = rise < 1 ? clip : null;
        clip.visible = rise < 1;
        for (const [k, Lr] of [["back", back], ["front", front]]) {
          clearFrame(Lr.frame);
          if (!fx.done()) fx.draw(Lr.frame, k);
          upload(Lr);
        }
        if (fx.done()) done();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    // Reveal the real token under the layer (it shows the same frame as the
    // copy), then drop the layer on the next frame so there is no gap.
    showToken(token);
    holdShadow(token, 1);
    await new Promise((r) => requestAnimationFrame(r));
    try { root.parent?.removeChild(root); root.destroy({ children: true, texture: false, baseTexture: false }); } catch { /* gone */ }
    for (const Lr of [back, front]) {
      for (const s of [Lr.color, Lr.light]) { try { s.texture.destroy(true); } catch { /* gone */ } }
    }
  }
  return true;
}

/* ── Geometry ───────────────────────────────────────────────────────────── */

// Effect px per scene px: one screen px at the scene's default battle view.
function densityFor(scene) {
  try {
    const v = restViewFor(scene);
    if (v?.scale > 0) return v.scale;
  } catch { /* no stage: the current view */ }
  return canvas.stage?.scale?.x || 1;
}

// The mesh's box in the primary group's (scene) space, and its facing.
function meshGeometry(token) {
  const mesh = token.mesh;
  try {
    const b = mesh.getBounds(false);
    if (b && b.width > 0 && b.height > 0) {
      const inv = (x, y) => canvas.primary.worldTransform.applyInverse(new PIXI.Point(x, y));
      const tl = inv(b.x, b.y), br = inv(b.x + b.width, b.y + b.height);
      return { tokenId: token.id, x0: tl.x, y0: tl.y, w: br.x - tl.x, h: br.y - tl.y, flip: (mesh.scale?.x ?? 1) < 0 ? -1 : 1 };
    }
  } catch { /* fall through */ }
  const w = Math.abs(mesh.width) || token.w, h = Math.abs(mesh.height) || token.h;
  return { tokenId: token.id, x0: token.center.x - w / 2, y0: token.center.y - h / 2, w, h, flip: (mesh.scale?.x ?? 1) < 0 ? -1 : 1 };
}

// The token's own art: the very element its mesh plays (an image or a video).
function tokenArt(token) {
  const src = token.mesh?.texture?.baseTexture?.resource?.source ?? null;
  if (!src) return null;
  const video = typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement;
  const w = video ? src.videoWidth : (src.naturalWidth ?? src.width);
  const h = video ? src.videoHeight : (src.naturalHeight ?? src.height);
  return w > 0 && h > 0 ? { src, w, h } : null;
}

/**
 * The creature as a pixelfx actor at effect density, facing the effect's +x:
 * { actor, feet (scene px), floorDy (effect px: its ground shadow below its feet) }.
 * Null when the art cannot be read (a cross-origin image without CORS).
 */
function buildActor(art, geo, D, face) {
  const W = Math.max(1, Math.round(geo.w * D)), H = Math.max(1, Math.round(geo.h * D));
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // as the mesh draws it on screen
  if (geo.flip < 0) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(art.src, 0, 0, W, H);
  let data;
  try { data = ctx.getImageData(0, 0, W, H).data; }
  catch (e) { warn("pixel-entrance: the token art cannot be read (CORS)", e); return null; }

  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] > MASK_ALPHA) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const mask = new Uint8Array(w * h), pixels = new Uint32Array(w * h);
  // the effect draws it facing right: mirror the columns when it faces left
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = face > 0 ? x0 + x : x1 - x, i = ((y0 + y) * W + sx) * 4;
    if (data[i + 3] <= MASK_ALPHA) continue;
    mask[y * w + x] = 1;
    pixels[y * w + x] = ((255 << 24) | (data[i + 2] << 16) | (data[i + 1] << 8) | data[i]) >>> 0;
  }
  const ax = -Math.floor(w / 2), ay = -h;
  const actor = { mask: { w, h, data: mask }, pixels, x: ax, y: ay, w, h, k: 2, head: [0, ay], chest: [0, Math.round(ay * 0.68)] };
  const feet = { x: geo.x0 + (x0 + x1 + 1) / 2 / D, y: geo.y0 + (y1 + 1) / D };

  // its ground shadow: the sprite-shadow ellipse when there is one, else the
  // shadow baked into the art (the faint dark pixels under it)
  let ground = null;
  try {
    const sh = shadowSpriteFor(geo.tokenId);
    if (sh && !sh.destroyed) {
      const b = sh.getBounds(false);
      if (b?.height > 0) ground = canvas.primary.worldTransform.applyInverse(new PIXI.Point(b.x + b.width / 2, b.y + b.height / 2)).y;
    }
  } catch { /* none */ }
  if (ground === null) {
    let n = 0, sy = 0;
    for (let y = Math.floor((y0 + y1) / 2); y < H; y++) for (let x = 0; x < W; x++) {
      const a = data[(y * W + x) * 4 + 3];
      if (a > 20 && a <= MASK_ALPHA) { n++; sy += y; }
    }
    if (n > 30) ground = geo.y0 + sy / n / D;
  }
  const floorDy = ground === null ? 0 : clamp(Math.round((ground - feet.y) * D), 0, Math.round(h * 0.3));
  return { actor, feet, floorDy };
}

/**
 * The camera's map of the floor at the feet, in the effect's own frame px:
 * { ex, ez } = where one floor px along the creature's facing / toward the
 * camera is drawn. Null when the camera cannot project.
 */
function floorMapAt(S3, feet, D, m, face) {
  const N = 40;   // effect px: long enough to measure, short enough to stay local
  const o = S3.projectNear?.(feet, { x: 0, h: 0, z: 0 });
  const ax = S3.projectNear?.(feet, { x: N / D, h: 0, z: 0 });
  const az = S3.projectNear?.(feet, { x: 0, h: 0, z: N / D });
  if (!o || !ax || !az) return null;
  const u = (m / D) * N;   // canvas px per N effect px at the feet
  const SX = [(ax.x - o.x) / u, (ax.y - o.y) / u], SZ = [(az.x - o.x) / u, (az.y - o.y) / u];
  if (![...SX, ...SZ].every(Number.isFinite)) return null;
  // local frame: +x is the facing (scene X * face), mirrored when it faces left
  return { ex: [SX[0], face * SX[1]], ez: [face * SZ[0], SZ[1]] };
}

/** The void dash's start and glint for where the creature stands on this screen. */
function dashOptions(root, A, o, face) {
  try {
    const F = makeFloor(o.floor, 0.24), d = F.front(), ux = Math.abs(F.at(d[0], d[1])[0]) || 1;
    const p = root.toGlobal(new PIXI.Point(0, 0));
    const g = Math.abs(root.worldTransform.a) || 1;   // screen px per effect px
    const sw = canvas.app?.renderer?.screen?.width ?? 1920;
    const edgePx = face > 0 ? p.x : sw - p.x;
    return dashSpan({ edge: edgePx / (g * ux), inset: GLINT_INSET_PX / (g * ux), bodyW: A.w });
  } catch { return {}; }
}

/**
 * The arena floor's colour under the feet, as a dark-to-light ramp of three
 * (the dust the dash kicks up). Null when the background cannot be read.
 */
function arenaDust(feet) {
  try {
    const d = canvas.dimensions, src = canvas.primary?.background?.texture?.baseTexture?.resource?.source;
    if (!d || !src) return null;
    const sw = src.naturalWidth ?? src.videoWidth ?? src.width, sh = src.naturalHeight ?? src.videoHeight ?? src.height;
    if (!(sw > 0 && sh > 0)) return null;
    const fx = (x) => ((x - d.sceneX) / d.sceneWidth) * sw, fy = (y) => ((y - d.sceneY) / d.sceneHeight) * sh;
    const x0 = fx(feet.x - 60), x1 = fx(feet.x + 60), y0 = fy(feet.y - 6), y1 = fy(feet.y + 14);
    const c = document.createElement("canvas");
    c.width = 8; c.height = 2;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0), 0, 0, 8, 2);
    const px = ctx.getImageData(0, 0, 8, 2).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 200) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
    if (!n) return null;
    const mid = [r / n, g / n, b / n];
    const hexOf = (v) => "#" + v.map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, "0")).join("");
    return [hexOf(mid.map((x) => x * 0.84)), hexOf(mid), hexOf(mid.map((x) => x + (255 - x) * 0.35))];
  } catch { return null; }
}

/* ── Token handling (the party-entrance-fx.js rules) ─────────────────────── */

function placeAtTokenDepth(layer, mesh) {
  const prim = canvas.primary;
  layer.elevation = mesh.elevation;
  layer.sortLayer = mesh.sortLayer;
  layer.sort = mesh.sort;
  layer.zIndex = mesh.zIndex;
  const i = prim.children.indexOf(mesh);
  if (i >= 0) prim.addChildAt(layer, i + 1);
  else prim.addChild(layer);
  prim.sortDirty = true;
}

function keepDepth(layer, mesh) {
  if (!mesh || mesh.destroyed) return;
  if (layer.elevation !== mesh.elevation || layer.sortLayer !== mesh.sortLayer || layer.sort !== mesh.sort || layer.zIndex !== mesh.zIndex) {
    layer.elevation = mesh.elevation; layer.sortLayer = mesh.sortLayer; layer.sort = mesh.sort; layer.zIndex = mesh.zIndex;
    canvas.primary.sortDirty = true;
  }
}

// The sprite shadow keeps its own copy of the mesh's alpha (`fudBase`) and
// re-applies it every frame, so hiding the mesh does not reach it.
function holdShadow(token, k) {
  const sh = shadowSpriteFor(token.id);
  if (!sh || sh.destroyed) return;
  const a = SHADOW_STYLE.alpha * k;
  if (sh.fudBase) sh.fudBase.alpha = a;
  sh.alpha = a;
}
function hideToken(token) {
  if (token.destroyed) return;
  try { token.alpha = 0; } catch { /* gone */ }
  try { if (token.mesh) token.mesh.alpha = 0; } catch { /* gone */ }
}
function showToken(token) {
  if (token.destroyed) return;
  try { token.alpha = 1; } catch { /* gone */ }
  try { if (token.mesh) token.mesh.alpha = 1; } catch { /* gone */ }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
