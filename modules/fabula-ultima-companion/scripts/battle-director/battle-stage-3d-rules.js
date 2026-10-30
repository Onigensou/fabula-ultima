// ============================================================================
// Battle stage 3D — the pure half (no Foundry globals; tested in bare Node by
// battle-stage-3d-rules.test.mjs).
//
// A battle backdrop is a painting of a floor seen by a camera. Once that
// camera is known, the battlefield has real 3D coordinates, and two things
// follow from it:
//
//   1. Depth scale. A battler standing further back is drawn smaller, by how
//      far its FEET are below the horizon: a pinhole camera draws a thing at
//      (footY - horizon) / (refY - horizon) of its size at the reference row.
//      The full physical ratio is too strong for readability (the back row of
//      the Training Ground would be 45% of the front), so it is softened by a
//      per-backdrop exponent and clamped.
//
//   2. Parallax. Each backdrop ships a depth map (Depth Anything V2, then
//      calibrated against the floor, see tools/battle-depth/). When the camera
//      pans, zooms or idly drifts, scenery behind the fight moves less than
//      the fight and scenery in front moves more, as it would for a real
//      camera. The band of floor the battlers stand on stays rigid, so nobody's
//      feet slide and nothing anchored to a token drifts off it.
//
// ── The depth map ───────────────────────────────────────────────────────────
//
// One grey channel, value = D / 2, where D is disparity (1/distance) scaled so
// the floor reads D = (y - horizon) / (stageBottom - horizon): 0 at infinity,
// 1 at the stage's bottom row, up to 2 for foreground rocks. It covers the
// whole backdrop image, bleed included, so its UVs are the backdrop's UVs.
//
// ── Coordinates ─────────────────────────────────────────────────────────────
//
// Preset rows (horizon, refRow, band) are STAGE-LOCAL on the 1682x788 base the
// formation is authored against (director-init computeLayout). buildCamera
// turns them into canvas space for the live stage rect.
// ============================================================================

export const BASE_STAGE = Object.freeze({ w: 1682, h: 788 });

export const DEPTH_MAP_DIR = "modules/fabula-ultima-companion/assets/battle-depth";

// Shared look. Every key can be overridden per backdrop, and live with
// FUCompanion.api.battleStage3d.tune({...}).
export const DEFAULTS = Object.freeze({
  // Token depth scale
  refRow: 440,          // stage row where a battler is drawn at its authored size
  strength: 0.33,       // exponent on the physical ratio (0 = off, 1 = true perspective)
  minScale: 0.6,
  maxScale: 1.12,
  // Metres (for effects that want real units)
  fovDeg: 40,           // horizontal field of view of the painted camera
  personM: 1.7,         // a one-grid battler at refRow is this tall
  // Parallax
  band: [190, 600],     // stage rows the battle line stands in; held rigid
  pan: 0.3,             // far scenery keeps this much of a camera pan (1 = sky fixed on screen)
  near: 0.6,            // foreground strength relative to `pan`
  dolly: 0.5,           // share of a zoom-in played as a dolly (far shrinks, near grows)
  orbitX: 12,           // idle drift amplitude, canvas px at the battle line
  orbitY: 3,
  orbitPeriodX: 26,     // seconds
  orbitPeriodY: 19,
  maxShift: 120,        // clamp on the camera offset fed to parallax, canvas px (big shifts tear depth edges)
  // Depth of field (mix toward a pre-blurred copy)
  dofFar: 0.4,
  dofNear: 0.55,
  blurPx: 5,
  // 3D camera (experimental, only on backdrops with a `stage3d` block)
  truck: 0.6,           // share of a pan played as the camera physically moving (0 = flat crop)
  camDolly: 0.5,        // share of a zoom played as a dolly (perspective change, framing kept)
  panYaw: 6,            // degrees of swing per stage width of pan
  swayYaw: 0.9,         // idle sway, degrees
  swayTilt: 0.35,
  swayPeriod: 26,       // seconds
});

// Per backdrop, keyed by the image's file name without extension. A `stage3d`
// block enables the 3D camera: either a floor + back wall (`wallRow`, an
// enclosed arena) or `relief: true` (the depth map pushed out into 3D, for
// open scenery). Its colours are optional; the camera samples the painting. Horizons
// come from tools/battle-depth/encode.py (floor fit of the depth model);
// the Training Ground one agrees with the earlier hand solve (row ~85).
// `strength` is set so the back row (feet ~row 217) lands near 0.72.
export const PRESETS = Object.freeze({
  // Training Ground (Eisendrache arena, v2 with bleed)
  Eisendrache_Battlemap001_v2: {
    horizon: 84.8, strength: 0.335,
    // Floor + back wall model for the 3D camera (stage rows). Colours fill
    // whatever the painting does not cover once the camera turns.
    stage3d: { wallRow: 114, backRow: 222, frontRow: 547, floorAvg: [0.40, 0.207, 0.158], wallAvg: [0.30, 0.21, 0.19], void: [0.071, 0.051, 0.043] },
  },
  // Overworld random battles (legacy scene, no bleed). Low camera, so the raw
  // perspective is steep; a gentle exponent keeps the back row readable.
  // Open country: a relief model (the depth map pushed out into 3D), not a wall.
  Eisendrache_Battlemap002: { horizon: 175.3, strength: 0.178, orbitX: 8, orbitY: 2, stage3d: { relief: true, backRow: 222, frontRow: 547 } },
  // Valley of the Dragon - Battle (v2)
  Valley_Battlemap001: { horizon: 52.0, strength: 0.386, stage3d: { relief: true, backRow: 222, frontRow: 547 } },
});

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** "https://…/Battlemap/Valley_Battlemap001.webp?v=2" -> "Valley_Battlemap001" */
export function backdropKey(src) {
  if (typeof src !== "string" || !src) return null;
  let s = src.split(/[?#]/)[0];
  s = s.slice(s.lastIndexOf("/") + 1);
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  const dot = s.lastIndexOf(".");
  return (dot > 0 ? s.slice(0, dot) : s) || null;
}

/**
 * The resolved settings for a backdrop, or null when it has no 3D preset.
 * `override` (live tuning) is merged on top of preset and defaults.
 */
export function resolvePreset(src, override = null) {
  const key = backdropKey(src);
  const preset = key ? PRESETS[key] : null;
  if (!preset) return null;
  return {
    ...DEFAULTS,
    ...preset,
    ...(override ?? {}),
    key,
    depthMap: `${DEPTH_MAP_DIR}/${key}.webp`,
  };
}

/**
 * The camera in canvas space.
 *
 * @param {object} cfg    resolvePreset() output
 * @param {object} stage  {x, y, w, h} canvas-space stage rect
 * @param {number} grid   scene grid size (px of one battler)
 */
export function buildCamera(cfg, stage, grid = 100) {
  const ky = stage.h / BASE_STAGE.h;
  const kx = stage.w / BASE_STAGE.w;
  const row = (r) => stage.y + r * ky;
  const hz = row(cfg.horizon);
  const refY = row(cfg.refRow);
  const bottomY = stage.y + stage.h;
  const f = (stage.w / 2) / Math.tan((cfg.fovDeg * Math.PI) / 360);
  const ppmRef = (grid * Math.max(kx, ky)) / cfg.personM;
  // Pinhole: px-per-metre at a floor row is f / Z = (y - hz) / camH.
  const camH = (refY - hz) / ppmRef;
  return {
    hz, refY, bottomY, f, camH, ppmRef,
    cx: stage.x + stage.w / 2,
    strength: cfg.strength, minScale: cfg.minScale, maxScale: cfg.maxScale,
    band: [row(cfg.band[0]), row(cfg.band[1])],
  };
}

/** Physical size ratio of something standing at footY vs. the reference row. */
export function physicalRatio(footY, cam) {
  const den = cam.refY - cam.hz;
  if (!(den > 0)) return 1;
  // Never at or above the horizon: hold a sliver of floor so the ratio stays positive.
  const num = Math.max(footY - cam.hz, den * 0.05);
  return num / den;
}

/** Draw scale for a battler whose feet are at footY. */
export function tokenScaleAt(footY, cam) {
  if (!finite(footY)) return 1;
  const s = Math.pow(physicalRatio(footY, cam), cam.strength);
  return clamp(s, cam.minScale, cam.maxScale);
}

/**
 * Draw scale for a battler on a backdrop with a 3D model (`P`, buildProjector):
 * the projector's own size ratio to the reference row, so a battler's 2D size is
 * exactly what the 3D camera assumes it is. tokenScaleAt's softened curve meets
 * the projector only at its two calibration rows; between and beyond them the two
 * drift apart (the party's back row came out 3.3% small under the camera,
 * 2026-10-31). Same clamps; tokenScaleAt when there is no model.
 */
export function battlerScaleAt(footY, cam, P = null) {
  if (!P) return tokenScaleAt(footY, cam);
  if (!finite(footY)) return 1;
  if (!(cam.strength > 0)) return 1;
  const s = restPxPerMetre(footY, P) / restPxPerMetre(cam.refY, P);
  return clamp(finite(s) ? s : 1, cam.minScale, cam.maxScale);
}

/** Calibrated floor disparity D at a canvas row (0 = horizon, 1 = stage bottom). */
export function floorDisparityAt(y, cam) {
  return Math.max(0, (y - cam.hz) / (cam.bottomY - cam.hz));
}

/** Pixels per metre on the floor at a canvas row (true perspective, not softened). */
export function pxPerMetreAt(y, cam) {
  return Math.max(0, y - cam.hz) / cam.camH;
}

/** Canvas point on the floor -> world metres {X across, Z away from camera}. */
export function floorToWorld({ x, y }, cam) {
  const dy = Math.max(1e-3, y - cam.hz);
  const Z = (cam.f * cam.camH) / dy;
  return { X: ((x - cam.cx) * Z) / cam.f, Z };
}

/**
 * World metres -> canvas point. Y is height above the floor. `scale` is the
 * TRUE perspective size factor relative to the reference row.
 */
export function worldToCanvas({ X = 0, Y = 0, Z }, cam) {
  const z = Math.max(1e-3, Z);
  return {
    x: cam.cx + (cam.f * X) / z,
    y: cam.hz + (cam.f * (cam.camH - Y)) / z,
    scale: cam.f / z / cam.ppmRef,
  };
}

/**
 * Parallax uniforms for this frame.
 *
 * view   {x, y, scale} live camera (canvas.stage pivot + scale)
 * rest   {x, y, scale} the director's rest framing on this client
 * t      seconds, for the idle drift
 * sceneRect {x, y, w, h} the backdrop's canvas rect
 * orbit  false to hold the idle drift (reduced motion)
 *
 * Returns offsetUV (camera offset in backdrop UV), pivotUV, dolly and the band
 * in D units, ready for the shader.
 */
export function parallaxUniforms({ view, rest, t = 0, cfg, cam, sceneRect, orbit = true }) {
  let ox = (Number(view?.x) || 0) - (Number(rest?.x) || 0);
  let oy = (Number(view?.y) || 0) - (Number(rest?.y) || 0);
  if (!finite(ox)) ox = 0;
  if (!finite(oy)) oy = 0;
  if (orbit) {
    ox += cfg.orbitX * Math.sin((2 * Math.PI * t) / cfg.orbitPeriodX);
    oy += cfg.orbitY * Math.sin((2 * Math.PI * t) / cfg.orbitPeriodY + 1.3);
  }
  const m = cfg.maxShift;
  ox = clamp(ox, -m, m);
  oy = clamp(oy, -m, m);
  const zoomRatio = (Number(view?.scale) || 1) / (Number(rest?.scale) || 1);
  const dolly = finite(zoomRatio) && zoomRatio > 0 ? cfg.dolly * (1 - 1 / zoomRatio) : 0;
  return {
    offsetUV: [(ox * cfg.pan) / sceneRect.w, (oy * cfg.pan) / sceneRect.h],
    pivotUV: [((Number(view?.x) || 0) - sceneRect.x) / sceneRect.w, ((Number(view?.y) || 0) - sceneRect.y) / sceneRect.h],
    dolly: clamp(dolly, -0.3, 0.3),
    band: [floorDisparityAt(cam.band[0], cam), floorDisparityAt(cam.band[1], cam)],
  };
}

/* ── 3D camera (experimental) ─────────────────────────────────────────────
 *
 * The backdrop becomes real geometry (a floor and a back wall) textured by
 * projecting the painting from a "projector" camera. The projector is the
 * painted camera with its depth compressed by the preset's `strength`, so the
 * sizes it implies match the depth scale battlers already get. At rest the
 * live camera IS the projector, and the render reproduces the painting
 * pixel for pixel.
 *
 * World: metres, X right, Y up, Z toward the viewer (the floor runs to -Z).
 * Geometry is either a floor + back wall (`wallRow`) or a relief: every
 * painting pixel pushed out along the projector's ray to its depth-map
 * distance (reliefDepth). Any geometry along those rays reproduces the
 * painting exactly at rest; they differ only once the camera moves.
 * The projector sits at (0, Hp, 0) looking down -Z, level.
 *
 * Canvas tokens stay where Foundry puts them; each frame they are displaced to
 * where the live camera sees their feet, and scaled by how much nearer or
 * further it has brought them (see projectLive / liveScaleAt).
 */

/**
 * Which treatment a scene gets, given the client setting and the backdrop's
 * resolved preset (null = no preset). Every scene degrades to what its
 * backdrop supports, ending at plain 2D:
 *   "camera" needs a `stage3d` model (floor + wall, or relief), else "full";
 *   "full" (parallax) and "scale" need a preset; no preset = "off" (plain 2D).
 */
export function stageModeFor(setting, cfg) {
  if (!cfg || setting === "off") return "off";
  if (setting === "camera") return cfg.stage3d ? "camera" : "full";
  return setting === "scale" ? "scale" : "full";
}

export const STAGE_LABEL = Object.freeze({ camera: "3d", full: "parallax", scale: "scale", off: "2d" });

/** Projector for a backdrop with a `stage3d` block, or null. */
export function buildProjector(cfg, cam, stage) {
  const g = cfg?.stage3d;
  if (!g) return null;
  const ky = stage.h / BASE_STAGE.h;
  const row = (r) => stage.y + r * ky;
  const front = row(g.frontRow), back = row(g.backRow);
  const s = cfg.strength;
  // Compressed horizon: the size ratio between the two rows becomes R^s.
  const R = Math.pow((front - cam.hz) / (back - cam.hz), s);
  const hz = s >= 0.999 || Math.abs(R - 1) < 1e-6 ? cam.hz : (front - R * back) / (1 - R);
  const Hp = (cam.refY - hz) / cam.ppmRef;
  const P = {
    hz, Hp, f: cam.f, cx: cam.cx,
    stageW: stage.w,
    relief: !!g.relief,
    wallY: g.wallRow == null ? null : row(g.wallRow),
    bottomY: cam.bottomY,
    bandY: cam.band,
    // Relief: the painted horizon (depth-map disparity 0) and how far it lies
    // once compressed; with no compression it is infinitely far, so it is
    // capped a sliver below the horizon instead.
    trueHz: cam.hz,
    blendPx: RELIEF_BLEND * ky,
    floorAvg: g.floorAvg ?? null,
    wallAvg: g.wallAvg ?? null,
    void: g.void ?? [0.05, 0.05, 0.05],
  };
  P.farZ = hz < cam.hz - 1e-6 ? floorDepth(cam.hz, P) : floorDepth(cam.hz + 0.03 * (cam.bottomY - cam.hz), P);
  return P;
}

// Stage rows over which the relief eases into the rigid floor of the battle band.
const RELIEF_BLEND = 40;

/**
 * Relief model: how far (m, along -Z) the projector ray through canvas row `y`
 * travels before it meets the scenery, given the depth map's disparity D there
 * (0 = the painted horizon, 1 = the stage's bottom row; see the header).
 *
 * The depth map is read through the painted camera, so a pixel of disparity D
 * sits as far away as the floor row where the PAINTED floor has that
 * disparity, then measured through the compressed projector. The floor plane
 * wins wherever it is nearer (the model never sinks below the ground), the
 * horizon caps it, and inside the battle band it IS the floor, so nobody's
 * feet move; the band's edges blend over RELIEF_BLEND rows.
 */
export function reliefDepth(y, D, P) {
  const zf = y > P.hz ? floorDepth(y, P) : Infinity;
  const yEq = P.trueHz + Math.max(0, Number(D) || 0) * (P.bottomY - P.trueHz);
  const zd = yEq > P.hz ? floorDepth(yEq, P) : Infinity;
  const z = Math.min(zf, zd, P.farZ);
  const [b0, b1] = P.bandY, bl = Math.max(1e-3, P.blendPx);
  const w = clamp(Math.min((y - (b0 - bl)) / bl, (b1 + bl - y) / bl), 0, 1);
  return w > 0 ? z + (Math.min(zf, P.farZ) - z) * w : z;
}

/** Canvas point pushed out to distance Z (m) along the projector's ray -> world {X, Y, Z}. */
export function reliefPoint({ x, y }, Z, P) {
  return { X: ((x - P.cx) * Z) / P.f, Y: P.Hp - ((y - P.hz) * Z) / P.f, Z: -Z };
}

/** Distance (m) to the floor at a canvas row, as the projector sees it. */
export function floorDepth(y, P) {
  return (P.f * P.Hp) / Math.max(1e-3, y - P.hz);
}

/** Canvas floor point -> world {X, Y: 0, Z}. */
export function floorPoint3({ x, y }, P) {
  const Z = floorDepth(y, P);
  return { X: ((x - P.cx) * Z) / P.f, Y: 0, Z: -Z };
}

/** Floor px per metre at a canvas row, in the projector (the rest view). */
export function restPxPerMetre(y, P) {
  return Math.max(1e-3, y - P.hz) / P.Hp;
}

const rotYX = (yawDeg, tiltDeg) => {
  // R = Ry(yaw) * Rx(-tilt); columns are the camera's right / up / back axes.
  const a = (yawDeg * Math.PI) / 180, b = (-tiltDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  return [
    [ca, sa * sb, sa * cb],
    [0, cb, -sb],
    [-sa, ca * sb, ca * cb],
  ];
};
const mulRv = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
const mulRtv = (R, v) => [R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2], R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2], R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]];

/** Camera-space ray slope of a world point: (x/-z, y/-z), and its depth -z. */
function camSlope(p, rig) {
  const c = mulRtv(rig.R, [p.X - rig.C[0], p.Y - rig.C[1], p.Z - rig.C[2]]);
  const d = Math.max(1e-3, -c[2]);
  return { sx: c[0] / d, sy: c[1] / d, d };
}

/**
 * The live camera for this frame.
 *
 * view   {x, y, scale}   PIXI camera (stage pivot + scale)
 * rest   {x, y, scale}   the director's rest framing
 * shot   {yaw, tilt, push}  scripted extras (degrees, degrees, distance factor)
 * t      seconds (idle sway); sway false holds it
 * neutral  0..1: how far to fold every 3D move back out (1 = the painted
 *        camera behind the 2D view, i.e. exact 2D: no truck, no dolly, no pan
 *        swing, no sway, no scripted shot)
 *
 * Returns { C, R, f, c0, yaw, tilt, k } where a world point lands on canvas at
 * c0 + f * slope. The floor point under the view centre is locked to the view
 * centre, so pans and zooms frame exactly as the 2D camera asked; what changes
 * is the perspective around it.
 */
export function rigCamera({ view, rest, shot = {}, t = 0, sway = true, neutral = 0 }, P, cfg) {
  const live = 1 - clamp(Number(neutral) || 0, 0, 1);
  const rowClamp = (y) => clamp(y, P.bandY[0], P.bottomY);
  const restC = { x: Number(rest?.x) || P.cx, y: rowClamp(Number(rest?.y) || P.bandY[1]) };
  const viewC = { x: Number(view?.x) || restC.x, y: rowClamp(Number(view?.y) || restC.y) };
  const truck = cfg.truck * live;
  const camC = { x: restC.x + (viewC.x - restC.x) * truck, y: restC.y + (viewC.y - restC.y) * truck };
  const T0 = floorPoint3(restC, P), Tc = floorPoint3(camC, P), Tv = floorPoint3(viewC, P);

  const z = (Number(view?.scale) || 1) / (Number(rest?.scale) || 1);
  const kD = clamp(Math.pow(finite(z) && z > 0 ? z : 1, -cfg.camDolly * live), 0.3, 1.6);
  const push = 1 + (clamp(Number(shot.push) || 1, 0.25, 2) - 1) * live;
  const k = kD * push;

  const panNorm = (viewC.x - restC.x) / P.stageW;
  const ph = (2 * Math.PI * t) / cfg.swayPeriod;
  const yaw = ((Number(shot.yaw) || 0) + cfg.panYaw * panNorm + (sway ? cfg.swayYaw * Math.sin(ph) : 0)) * live;
  const tilt = ((Number(shot.tilt) || 0) + (sway ? cfg.swayTilt * Math.sin(ph * 0.73 + 1.1) : 0)) * live;

  const R = rotYX(yaw, tilt);
  const off = mulRv(R, [(0 - T0.X) * k, (P.Hp - 0) * k, (0 - T0.Z) * k]);
  const C = [Tc.X + off[0], Math.max(0.3, Tc.Y + off[1]), Tc.Z + off[2]];
  const rig = { C, R, yaw, tilt, k };
  // The dolly part is lens-compensated (framing kept, perspective changes);
  // a scripted push is not (it really moves in).
  rig.f = P.f * kD;
  const s = camSlope(Tv, rig);
  rig.c0 = { x: viewC.x - rig.f * s.sx, y: viewC.y + rig.f * s.sy };
  return rig;
}

/** World point -> canvas point through the live camera. */
export function projectLive(p, rig) {
  const s = camSlope(p, rig);
  return { x: rig.c0.x + rig.f * s.sx, y: rig.c0.y - rig.f * s.sy, depth: s.d };
}

/**
 * Where a battler with feet at canvas point `foot` is drawn by the live camera,
 * and how much larger than at rest.
 */
export function liveBattler(foot, P, rig) {
  const y = Math.max(foot.y, P.hz + 2);
  const p = floorPoint3({ x: foot.x, y }, P);
  const a = projectLive(p, rig);
  const b = projectLive({ X: p.X, Y: 1, Z: p.Z }, rig);
  const ppm = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: a.x, y: a.y, scale: ppm / restPxPerMetre(y, P), depth: a.depth };
}

/**
 * Where a point in the arena near a battler with feet at canvas point `foot` is
 * drawn by the live camera. `off` = {x, h, z} in rest canvas px at the feet's
 * row: x along the canvas X, h straight up, z along the floor toward the
 * camera. Returns the drawn point {x, y}, the drawn feet {fx, fy}, and s = how
 * large it is drawn relative to the feet (nearer > 1). For effects whose paths
 * live in the arena rather than on the battler's card.
 */
export function projectNearFoot(foot, off, P, rig) {
  const y = Math.max(foot.y, P.hz + 2);
  const F = floorPoint3({ x: foot.x, y }, P);
  const u = 1 / restPxPerMetre(y, P);   // metres per rest px on this row
  const a = projectLive(F, rig);
  const b = projectLive({ X: F.X + (Number(off?.x) || 0) * u, Y: (Number(off?.h) || 0) * u, Z: F.Z + (Number(off?.z) || 0) * u }, rig);
  return { x: b.x, y: b.y, fx: a.x, fy: a.y, s: clamp(a.depth / Math.max(1e-3, b.depth), 0.2, 4) };
}

/**
 * The shader's displacement, in UV, for a pixel at `uv` with disparity D.
 * Mirrors the GLSL exactly so the maths is testable without a GPU.
 */
export function shiftUV(uv, D, u, cfg) {
  const [dBack, dFront] = u.band;
  const far = clamp(1 - D / Math.max(dBack, 1e-4), 0, 1);
  const near = clamp((D - dFront) / Math.max(dFront, 1e-4), 0, 1.5);
  const w = far - cfg.near * near;
  return [
    w * (u.offsetUV[0] + (u.pivotUV[0] - uv[0]) * u.dolly),
    w * (u.offsetUV[1] + (u.pivotUV[1] - uv[1]) * u.dolly),
  ];
}
