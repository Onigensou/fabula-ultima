// ============================================================================
// Map surface FX: the pure half (no Foundry, no PIXI). Reads a scene's flags
// into the numbers map-surface-fx.js draws with. Tested by
// map-surface-fx-core.test.mjs.
//
// Scene flags (flags.fabula-ultima-companion):
//   oniFabula.general.surfaceFxEnabled   Scene Config "Ambient FX" switch.
//                                        Must be true; false also stops the
//                                        map-ambience particles on that scene.
//   surfaceFx = {
//     mode: "gas" | "water",
//     layers: { churn, plume, rim, crystal, wisp, water, light },  booleans
//     crystals: [[x, y, r]],             soft pulsing glows (map px)
//     crystalColor: [r, g, b],           0..1
//     wisp: 0.16,                         near-haze strength, 0 = none
//     wispOutsideLight: false,            true = the haze thins out inside the
//                                         light pools (Valley camp: clear camp,
//                                         hazy storm side)
//     darkness: 0.32,                     how dark unlit stone gets ("light" layer)
//     lightCap: 1.25,                     how far a light pool may brighten the
//                                         painting (1.25 = the mockup's cap; the
//                                         Valley camp pond uses more)
//     lights: [[x, y, radius, r, g, b, strength]],
//     shimmerTile: "<tile id>", shimmer: { cx, cy, squash }   seal sheen
//   }
// The mask lives at assets/surface-fx/<background file name>.webp (baked by
// tools/safe-edit/bin/_surface-fx-bake-mask.mjs).
// ============================================================================

export const MODULE_ID = "fabula-ultima-companion";
export const FLAG = "surfaceFx";
export const ENABLED_KEY = "surfaceFxEnabled";
export const MASK_DIR = "modules/fabula-ultima-companion/assets/surface-fx";
export const MAX_CRYSTALS = 10;
export const MAX_LIGHTS = 12;

const LAYERS = {
  gas: ["churn", "plume", "rim", "crystal", "wisp"],
  water: ["water", "light", "crystal", "wisp"],
};

const num = (v, d) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** "https://…/Game%20Map/Valley_Map032.png?v=2" -> "Valley_Map032" (same rule as exploration-parallax.js) */
export function backdropKey(src) {
  if (typeof src !== "string" || !src) return null;
  let s = src.split(/[?#]/)[0];
  s = s.slice(s.lastIndexOf("/") + 1);
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  const dot = s.lastIndexOf(".");
  return (dot > 0 ? s.slice(0, dot) : s) || null;
}

export function maskPathFor(src) {
  const key = backdropKey(src);
  return key ? `${MASK_DIR}/${key}.webp` : null;
}

function triples(list, max, minR) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every((v) => Number.isFinite(Number(v))))
    .slice(0, max)
    .map(([x, y, r]) => [Number(x), Number(y), Math.max(minR, Number(r))]);
}

function color(c, d) {
  return Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(Number(v)))
    ? c.map((v) => clamp(Number(v), 0, 2)) : d;
}

/**
 * A scene-like object ({ flags, background: { src } }) -> config or null.
 * null = draw nothing on this scene.
 */
export function readSurfaceConfig(scene) {
  const flags = scene?.flags?.[MODULE_ID];
  const general = flags?.oniFabula?.general ?? {};
  if (general[ENABLED_KEY] !== true) return null;
  // Walk maps and camps (both are walked on); tile-path dungeons and theatres are not.
  if (general.sceneMode && general.sceneMode !== "exploration" && general.sceneMode !== "camp") return null;
  // Walk parallax redraws the same painting; the two would stack. Parallax wins.
  if (general.parallaxEnabled === true) return null;
  const raw = flags?.[FLAG];
  if (!raw || typeof raw !== "object") return null;
  const mode = raw.mode === "water" ? "water" : raw.mode === "gas" ? "gas" : null;
  if (!mode) return null;
  const mask = maskPathFor(scene?.background?.src);
  if (!mask) return null;

  const layers = {};
  for (const id of LAYERS[mode]) layers[id] = raw.layers?.[id] !== false;

  const lights = Array.isArray(raw.lights)
    ? raw.lights
      .filter((l) => Array.isArray(l) && l.length >= 7 && l.slice(0, 7).every((v) => Number.isFinite(Number(v))))
      .slice(0, MAX_LIGHTS)
      .map((l) => l.slice(0, 7).map(Number))
    : [];

  const sh = raw.shimmer ?? {};
  return {
    mode,
    mask,
    layers,
    crystals: triples(raw.crystals, MAX_CRYSTALS, 1),
    crystalColor: color(raw.crystalColor, [0.70, 0.48, 1.0]),
    wisp: layers.wisp ? clamp(num(raw.wisp, mode === "gas" ? 0.16 : 0.12), 0, 1) : 0,
    wispOutsideLight: raw.wispOutsideLight === true,
    darkness: clamp(num(raw.darkness, 0.32), 0, 1),
    lightCap: clamp(num(raw.lightCap, 1.25), 1, 3),
    lights,
    shimmerTile: typeof raw.shimmerTile === "string" && raw.shimmerTile ? raw.shimmerTile : null,
    shimmer: { cx: num(sh.cx, 1024), cy: num(sh.cy, 820), squash: clamp(num(sh.squash, 1.9), 0.2, 5) },
  };
}

/**
 * The rule map-ambience.js follows (it is a classic script and keeps its own
 * copy): a scene SET UP for surface FX stops its ambience unless the switch is
 * on. Other scenes ignore the switch — an unticked box saves false everywhere,
 * and Maelstrom's ambience has no switch.
 */
export function ambientSwitchedOff(scene) {
  const fu = scene?.flags?.[MODULE_ID];
  return !!fu?.[FLAG] && fu?.oniFabula?.general?.[ENABLED_KEY] !== true;
}
