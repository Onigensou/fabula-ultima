// ============================================================================
// Battle stand — a per-actor nudge to where a battler stands in battle (pure;
// tested in bare Node by battle-stand.test.mjs).
//
// The formation (director-init computeLayout / formation.js) puts every battler
// on its side's line. Some creatures need a different spot: a giant whose face
// should sit in the middle of the screen above the HUD stands further BACK on
// the floor, so it is drawn higher. An actor declares it with
//
//   flags.fabula-ultima-companion.battleStand = { back, x, keepSize }
//
//   back      reference-stage px (the 1682x788 base every layout is authored
//             on) the token moves up the stage = further back on the floor.
//             Negative = toward the camera.
//   x         reference-stage px to the right (optional, default 0).
//   keepSize  true = scale the token up by exactly what the depth scale takes
//             away at the new spot, so it is drawn the size it was at its
//             formation spot (the 3D camera's depth curve; see
//             battle-stage-3d-rules.js battlerScaleAt), and move its texture
//             anchor so the larger texture grows UP from the sprite's bottom
//             edge instead of out from its middle: the sprite is then drawn
//             exactly as before, only `back` higher. (Scale alone grows the
//             sprite about the token centre, so a point below the sprite's
//             middle, such as a giant's head drawn low in its painting, moves
//             DOWN and eats most of the lift.) Default true.
//
// Applied once, when the director spawns the token (director-init
// spawnTokensHidden), so everything that reads the token afterwards (the boss
// cycle's core "where the boss stands", the shows, the camera, the sprite
// shadow, unit-inspect) follows it with no change of its own.
// ============================================================================

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** The actor's battleStand flag, normalised, or null when it asks for nothing. */
export function readBattleStand(raw) {
  if (!raw || typeof raw !== "object") return null;
  const back = Number(raw.back) || 0;
  const x = Number(raw.x) || 0;
  const keepSize = raw.keepSize !== false;
  if (!back && !x) return null;
  return { back, x, keepSize };
}

/**
 * The texture anchor (y) that keeps the sprite's planted bottom edge where it was relative to the token centre once
 * its texture is scaled by sizeK: depth-index.js plants the bottom at centre + (1 - anchorY) * height, so
 * (1 - a') * h * sizeK = (1 - a) * h.
 */
export function keepSizeAnchor(anchorY = 0.5, sizeK = 1) {
  const a = Number.isFinite(Number(anchorY)) ? Number(anchorY) : 0.5;
  if (!(sizeK > 0) || sizeK === 1) return a;
  return 1 - (1 - a) / sizeK;
}

/**
 * Where the token goes and how much larger it is drawn.
 *
 * centre    {x, y} canvas token centre from the formation
 * stand     readBattleStand() output (null = unchanged)
 * k         {x, y} canvas px per reference-stage px (stage.w / 1682, stage.h / 788)
 * feetBelow canvas px from the token centre down to its feet (token box bottom, where depth is read)
 * factorAt  (footY) -> the depth draw scale at canvas row footY, or null when the scene has none
 *
 * anchorY   the texture's anchor y (0.5 default)
 *
 * -> { centre: {x, y}, sizeK, anchorY }   sizeK multiplies the token's texture scale (1 = as authored), anchorY is
 *    the texture anchor to give it (keepSizeAnchor; unchanged when sizeK is 1)
 */
export function applyBattleStand({ centre, stand, k = { x: 1, y: 1 }, feetBelow = 0, factorAt = null, anchorY = 0.5 }) {
  if (!stand) return { centre: { x: centre.x, y: centre.y }, sizeK: 1, anchorY };
  const out = { x: centre.x + stand.x * k.x, y: centre.y - stand.back * k.y };
  let sizeK = 1;
  if (stand.keepSize && typeof factorAt === "function") {
    const f0 = Number(factorAt(centre.y + feetBelow)), f1 = Number(factorAt(out.y + feetBelow));
    if (finite(f0) && finite(f1) && f0 > 0 && f1 > 0) sizeK = f0 / f1;
  }
  return { centre: out, sizeK, anchorY: keepSizeAnchor(anchorY, sizeK) };
}

/**
 * Where a point of the sprite is drawn at rest, in canvas px, for a token whose
 * mesh is planted the way map-system/depth-index.js plants it (the mesh's
 * bottom edge held where it is at depth scale 1, scaled up from there):
 *
 * cy        canvas token centre y
 * h0        drawn sprite height at depth scale 1 (texture fitted into the box x texture scale)
 * anchorY   the texture's anchor (0.5 default)
 * f         the depth draw scale at its feet
 * v         the point's height in the sprite, 0 top .. 1 bottom
 */
export function spritePointY({ cy, h0, anchorY = 0.5, f = 1, v }) {
  const bottom = cy + (1 - anchorY) * h0;
  return bottom - (1 - v) * h0 * f;
}

/**
 * Solve `back` (reference px) so a point of the sprite (v, 0 top .. 1 bottom)
 * lands on screen row `targetY` at the rest framing, with keepSize (texture
 * scaled by sizeK and anchored by keepSizeAnchor, as applyBattleStand does; the
 * point then rises by exactly back * ky * view.scale, so this is a check of
 * that as much as a search).
 *
 * view      {y, scale} the rest framing (stage pivot y + scale); screenH the viewport height
 * cy        canvas token centre at the formation spot; feetBelow, h0, anchorY as above
 * ky        canvas px per reference px vertically
 * factorAt  (footY) -> depth draw scale
 * range     [lo, hi] reference px to search (default [-200, 400])
 *
 * -> { back, y, sizeK, f } the solved back offset, the point's screen row there, the size factor and the depth
 *    scale at the new feet; null when the target is out of reach in the range.
 */
export function solveStandBack({ targetY, view, screenH, cy, feetBelow, h0, anchorY = 0.5, v, ky = 1, factorAt, range = [-200, 400] }) {
  const f0 = factorAt(cy + feetBelow);
  const at = (back) => {
    const cy1 = cy - back * ky;
    const f1 = factorAt(cy1 + feetBelow);
    const sizeK = f0 / f1;
    const yc = spritePointY({ cy: cy1, h0: h0 * sizeK, anchorY: keepSizeAnchor(anchorY, sizeK), f: f1, v });
    return { back, y: (yc - view.y) * view.scale + screenH / 2, sizeK, f: f1 };
  };
  let [lo, hi] = range;
  let a = at(lo), b = at(hi);
  // the point rises (y falls) as back grows
  if (!(a.y >= targetY && b.y <= targetY)) return null;
  for (let i = 0; i < 60; i++) {
    const m = at((lo + hi) / 2);
    if (m.y > targetY) { lo = m.back; a = m; } else { hi = m.back; b = m; }
  }
  return at((lo + hi) / 2);
}

/** Token flag (under the module namespace) holding the formation centre a battleStand token was moved FROM. */
export const BASE_SPOT_FLAG = "battleStandBase";

/**
 * Where a token's FEET stood before its battleStand offset (its un-offset formation spot), for anything that must
 * not follow the offset (the Sealing Crystal spawns here, ruling 2026-11-20). Reads the formation centre that
 * spawnTokensHidden stored on the token; a token without it (no battleStand) just returns its current feet.
 *
 * tokenDoc  {x, y, width, height, flags}  (top-left x/y, size in cells)
 * ns        the module flag namespace; g the grid size in canvas px
 * -> { x, y }
 */
export function baseFeetOf(tokenDoc, ns, g) {
  const base = tokenDoc?.flags?.[ns]?.[BASE_SPOT_FLAG];
  const w = Number(tokenDoc?.width) || 1, h = Number(tokenDoc?.height) || 1;
  if (base && finite(Number(base.x)) && finite(Number(base.y))) return { x: Number(base.x), y: Number(base.y) + (h * g) / 2 };
  return { x: tokenDoc.x + (w * g) / 2, y: tokenDoc.y + h * g };
}
